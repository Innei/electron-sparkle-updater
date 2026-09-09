import argparse
import importlib.util
import json
import plistlib
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("history", Path(__file__).parents[1] / "scripts/appcast-history.py")
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
S = history.S


def feed(versions):
    root = ET.Element("rss")
    channel = ET.SubElement(root, "channel")
    for version, sources in versions:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, S + "version").text = version
        ET.SubElement(item, "enclosure", {"url": f"https://example.com/{version}.zip", "length": "1000"})
        deltas = ET.SubElement(item, S + "deltas")
        for source in sources:
            ET.SubElement(deltas, "enclosure", {S + "deltaFrom": source, "url": f"https://example.com/original/{source}-{version}.delta", S + "edSignature": f"signed-{source}-{version}", "length": "20"})
    return root


class AppcastHistoryTest(unittest.TestCase):
    def test_preserves_historical_assets_recovers_edges_and_prunes_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            latest = Path(tmp) / "latest.xml"
            older = Path(tmp) / "older.xml"
            ET.ElementTree(feed([("5", ["3"]), ("3", ["2"]), ("2", ["1"]), ("1", [])])).write(latest)
            ET.ElementTree(feed([("3", ["1"]), ("2", ["1"]), ("1", [])])).write(older)
            merged = history.merge(feed([("6", ["5", "3"])]), [latest, older], 4)
            items = merged.findall("./channel/item")
            self.assertEqual([history.version(i) for i in items], ["6", "5", "3", "2", "1"])
            edge = next(e for e in items[2].findall(f"{S}deltas/enclosure") if e.get(S + "deltaFrom") == "1")
            self.assertEqual(edge.get("url"), "https://example.com/original/1-3.delta")
            self.assertEqual(edge.get(S + "edSignature"), "signed-1-3")
            pruned = history.merge(feed([("6", ["5", "3"])]), [latest, older], 2)
            self.assertEqual([history.version(i) for i in pruned.findall("./channel/item")], ["6", "5", "3"])
            self.assertEqual([e.get(S + "deltaFrom") for e in pruned.findall(f"./channel/item/{S}deltas/enclosure")], ["5", "3", "3"])

    def test_fetch_downloads_two_zips_and_only_metadata_for_older_releases(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with zipfile.ZipFile(directory / "App-7-arm64-mac.zip", "w") as archive:
                archive.writestr("App.app/Contents/Info.plist", plistlib.dumps({"CFBundleVersion": "7"}))
            downloads = []
            def run_gh(*args):
                if args[:2] == ("release", "list"):
                    return json.dumps([{"tagName": f"v{v}", "publishedAt": str(v)} for v in range(6, 0, -1)])
                v = args[2][1:]
                return json.dumps({"assets": [{"name": "appcast.xml"}, {"name": f"App-{v}-arm64-mac.zip"}, {"name": f"App-{v}-x64-mac.zip"}, {"name": "old.delta"}]})
            def download(command, **kwargs):
                asset = command[command.index("--pattern") + 1]
                target = Path(command[command.index("--dir") + 1]) / asset
                downloads.append(asset)
                if asset == "appcast.xml":
                    ET.ElementTree(feed([(str(v), [str(v - 1)] if v > 1 else []) for v in range(6, 0, -1)])).write(target)
                else:
                    target.write_bytes(b"archive")
            args = argparse.Namespace(archive_dir=tmp, repo="owner/repo", tag="v7", tag_prefix="v", bases=2, history=6)
            with patch.object(history, "gh", side_effect=run_gh), patch.object(history.subprocess, "run", side_effect=download):
                history.fetch(args)
            self.assertEqual(downloads, ["appcast.xml", "App-6-arm64-mac.zip", "App-5-arm64-mac.zip"])

    def test_rejects_entity_expansion_and_ambiguous_current_feed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.xml"
            path.write_text('<!DOCTYPE rss [<!ENTITY x "a">]><rss><channel>&x;</channel></rss>')
            with self.assertRaises(ValueError):
                history.read_feed(path)
        with self.assertRaises(ValueError):
            history.merge(feed([("2", []), ("1", [])]), [], 6)


if __name__ == "__main__":
    unittest.main()
