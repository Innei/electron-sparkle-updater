#!/usr/bin/env python3
"""Keep a bounded Sparkle history without downloading historical delta assets."""
import argparse
import copy
import json
import plistlib
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"
S = "{" + SPARKLE + "}"
ET.register_namespace("sparkle", SPARKLE)
ET.register_namespace("dc", "http://purl.org/dc/elements/1.1/")


def bounded(value):
    number = int(value)
    if not 0 <= number <= 32:
        raise argparse.ArgumentTypeError("must be between 0 and 32")
    return number


def read_feed(path):
    data = Path(path).read_bytes()
    if len(data) > 8 * 1024 * 1024 or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError(f"unsafe or oversized appcast: {path}")
    root = ET.fromstring(data)
    if root.tag != "rss" or root.find("channel") is None:
        raise ValueError(f"not a Sparkle RSS feed: {path}")
    return root


def version(item):
    enclosure = item.find("enclosure")
    return item.findtext(S + "version") or (enclosure.get(S + "version") if enclosure is not None else None)


def archive_version(path):
    with zipfile.ZipFile(path) as archive:
        entries = [entry for entry in archive.infolist()
                   if len(entry.filename.split("/")) == 3
                   and entry.filename.split("/")[0].endswith(".app")
                   and entry.filename.endswith("/Contents/Info.plist")]
        if len(entries) != 1 or entries[0].file_size > 2 * 1024 * 1024:
            raise ValueError("expected one top-level .app/Contents/Info.plist")
        value = plistlib.loads(archive.read(entries[0])).get("CFBundleVersion")
    if not isinstance(value, str) or not value or any(c in value for c in "\r\n,"):
        raise ValueError("invalid CFBundleVersion")
    return value


def merge(current, history_files, count):
    """Current item wins. Preserve original historical URLs and union missing edges."""
    channel = current.find("channel")
    own_items = channel.findall("item")
    if len(own_items) != 1 or not version(own_items[0]):
        raise ValueError("generate current appcast with --versions and --maximum-versions 1")
    own = own_items[0]
    own_channel = own.findtext(S + "channel", "")
    items = {version(own): own}
    for path in history_files:
        for incoming in read_feed(path).findall("./channel/item"):
            build = version(incoming)
            if not build or build == version(own) or incoming.findtext(S + "channel", "") != own_channel:
                continue
            if build not in items:
                items[build] = copy.deepcopy(incoming)
            else:
                saved = items[build]
                deltas = saved.find(S + "deltas")
                for edge in incoming.findall(f"{S}deltas/enclosure"):
                    if deltas is None:
                        deltas = ET.SubElement(saved, S + "deltas")
                    if not any(e.get(S + "deltaFrom") == edge.get(S + "deltaFrom") for e in deltas):
                        deltas.append(copy.deepcopy(edge))
    # History files are snapshots supplied newest-first by GitHub release order.
    kept = list(items.values())[:count + 1]
    versions = {version(item) for item in kept}
    for item in kept:
        for deltas in item.findall(S + "deltas"):
            for edge in list(deltas):
                if edge.get(S + "deltaFrom") not in versions or edge.get(S + "deltaFrom") == version(item):
                    deltas.remove(edge)
        if item is not own:
            channel.append(item)
    return current


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def fetch(args):
    directory = Path(args.archive_dir)
    history = directory / "history"
    history.mkdir(exist_ok=True)
    releases = json.loads(gh("release", "list", "--repo", args.repo, "--exclude-drafts", "--exclude-pre-releases",
                            "--limit", "100", "--json", "tagName,publishedAt"))
    releases = sorted((r for r in releases if r["tagName"].startswith(args.tag_prefix) and r["tagName"] != args.tag),
                      key=lambda r: r["publishedAt"], reverse=True)[:max(args.history, args.bases)]
    seen = set()
    own_zips = list(directory.glob("*.zip"))
    if len(own_zips) != 1:
        raise ValueError("use one archive directory / appcast per architecture")
    # Match the platform suffix, not every ZIP in a release containing multiple architectures.
    own_version = archive_version(own_zips[0])
    marker = own_zips[0].name.find(own_version)
    suffix = own_zips[0].name[marker + len(own_version):] if marker >= 0 else ".zip"
    for index, release in enumerate(releases):
        tag = release["tagName"]
        assets = json.loads(gh("release", "view", tag, "--repo", args.repo, "--json", "assets"))["assets"]
        if index < args.history and len(seen) < args.history:
            if any(a["name"] == "appcast.xml" for a in assets):
                folder = history / f"{index:02d}"
                folder.mkdir(exist_ok=True)
                subprocess.run(["gh", "release", "download", tag, "--repo", args.repo, "--pattern", "appcast.xml", "--dir", str(folder)], check=True)
                seen.update(version(i) for i in read_feed(folder / "appcast.xml").findall("./channel/item") if version(i))
        if index < args.bases:
            zips = [a["name"] for a in assets if a["name"].endswith(suffix)]
            if len(zips) > 1:
                raise ValueError(f"ambiguous delta base archives on {tag}")
            if zips:
                subprocess.run(["gh", "release", "download", tag, "--repo", args.repo, "--pattern", zips[0], "--dir", str(directory)], check=True)
            else:
                print(f"No matching ZIP on {tag}; fewer direct deltas will be generated.", file=sys.stderr)
        if index + 1 >= args.bases and len(seen) >= args.history:
            break


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fetch_parser = commands.add_parser("fetch")
    for key in ("repo", "tag", "tag-prefix", "archive-dir"):
        fetch_parser.add_argument("--" + key, required=True)
    fetch_parser.add_argument("--bases", type=bounded, default=2)
    fetch_parser.add_argument("--history", type=bounded, default=6)
    merge_parser = commands.add_parser("merge")
    merge_parser.add_argument("appcast")
    merge_parser.add_argument("--history-dir", required=True)
    merge_parser.add_argument("--history", type=bounded, default=6)
    version_parser = commands.add_parser("version")
    version_parser.add_argument("archive")
    args = parser.parse_args()
    if args.command == "fetch":
        fetch(args)
    elif args.command == "version":
        print(archive_version(args.archive))
    else:
        root = merge(read_feed(args.appcast), sorted(Path(args.history_dir).glob("*/appcast.xml")), args.history)
        # ElementTree removes the old feed-signature comments. Sign the final XML afterwards.
        ET.indent(root)
        ET.ElementTree(root).write(args.appcast, encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, ET.ParseError, OSError, subprocess.CalledProcessError) as error:
        print(f"appcast history: {error}", file=sys.stderr)
        sys.exit(1)
