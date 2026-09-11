#!/usr/bin/env python3
"""Exercise the real Sparkle downloader, IPC, installer, fallback and cancellation."""
import argparse
import functools
import http.server
import os
import plistlib
import secrets
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--framework", required=True, type=Path)
    parser.add_argument("--tools", required=True, type=Path)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="sparkle-chain-integration-"))
    print(f"Fixtures and logs: {root}", flush=True)
    key, public = root / "key", root / "public"
    run("swift", "-e", 'import CryptoKit; import Foundation; let k = Curve25519.Signing.PrivateKey(); try k.rawRepresentation.base64EncodedString().write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8); try k.publicKey.rawRepresentation.base64EncodedString().write(toFile: CommandLine.arguments[2], atomically: true, encoding: .utf8)', key, public)
    key.chmod(0o600)
    identifier = "dev.innei.delta-fixture." + secrets.token_hex(6)
    blob = secrets.token_bytes(1024 * 1024)
    (root / "fixture.c").write_text("int main(void) { return 0; }")
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    for version in ("1", "3", "5", "6"):
        app = root / version / "ChainFixture.app"
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/Resources").mkdir()
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": identifier, "CFBundleName": "ChainFixture", "CFBundleExecutable": "fixture",
            "CFBundleVersion": version, "CFBundleShortVersionString": version, "CFBundlePackageType": "APPL",
            "LSMinimumSystemVersion": "12.0", "SUPublicEDKey": public.read_text(), "SUFeedURL": "http://127.0.0.1/appcast.xml",
            "SUEnableAutomaticChecks": False, "SUEnableInstallerLauncherService": False, "SUDeltaChainHistory": 6,
        }))
        (app / "Contents/Resources/data").write_bytes(blob + version.encode())
        run("clang", root / "fixture.c", "-o", app / "Contents/MacOS/fixture")
        run("codesign", "--force", "--sign", "-", app, **quiet)
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", root / "6/ChainFixture.app", root / "6.zip")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def copyfile(self, source, output):
            try:
                if self.path.endswith(".delta"):
                    while chunk := source.read(128):
                        output.write(chunk)
                        output.flush()
                        time.sleep(0.02)
                else:
                    super().copyfile(source, output)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Expected when testing cancellation.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(root)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    S = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
    ET.register_namespace("sparkle", S[1:-1])
    def signature(path):
        return subprocess.check_output([str(args.tools / "sign_update"), "--ed-key-file", str(key), "-p", str(path)], text=True).strip()
    feed = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(feed, "channel")
    for version in ("6", "5", "3", "1"):
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, S + "version").text = version
        ET.SubElement(item, "enclosure", {"url": url + "/6.zip", "length": str((root / "6.zip").stat().st_size), S + "edSignature": signature(root / "6.zip")})
        source = {"6": "5", "5": "3", "3": "1"}.get(version)
        if source:
            delta = root / f"{source}-{version}.delta"
            run(args.tools / "BinaryDelta", "create", "--version=4", root / source / "ChainFixture.app", root / version / "ChainFixture.app", delta)
            ET.SubElement(ET.SubElement(item, S + "deltas"), "enclosure", {
                "url": url + "/" + delta.name, "length": str(delta.stat().st_size), S + "deltaFrom": source, S + "edSignature": signature(delta),
            })
    ET.ElementTree(feed).write(root / "appcast.xml", xml_declaration=True, encoding="utf-8")
    for mode in ("corrupt", "missing"):
        tree = ET.parse(root / "appcast.xml")
        for enclosure in tree.findall(".//enclosure"):
            if enclosure.get(S + "deltaFrom") == "3":
                enclosure.set("url", url + f"/{mode}.delta")
        tree.write(root / f"{mode}.xml", xml_declaration=True, encoding="utf-8")
    corrupt = bytearray((root / "3-5.delta").read_bytes())
    corrupt[-1] ^= 1
    (root / "corrupt.delta").write_bytes(corrupt)
    harness = root / "Harness.app"
    (harness / "Contents/MacOS").mkdir(parents=True)
    (harness / "Contents/Frameworks").mkdir()
    run("ditto", args.framework, harness / "Contents/Frameworks/Sparkle.framework")
    (harness / "Contents/Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": identifier + ".harness", "CFBundleExecutable": "harness", "CFBundleVersion": "1",
        "CFBundleName": "ChainHarness", "CFBundlePackageType": "APPL", "LSUIElement": True,
        "SUEnableDownloaderService": False, "SUEnableInstallerLauncherService": False,
    }))
    run("clang", "-fobjc-arc", "-framework", "AppKit", "-framework", "Sparkle", "-F" + str(harness / "Contents/Frameworks"),
        "-Wl,-rpath,@executable_path/../Frameworks", Path(__file__).with_name("updater-harness.m"), "-o", harness / "Contents/MacOS/harness")
    run("codesign", "--force", "--deep", "--sign", "-", harness, **quiet)
    try:
        for mode in ("success", "corrupt", "missing", "window", "cancel"):
            host = root / ("installed-" + mode) / "ChainFixture.app"
            run("ditto", root / "1/ChainFixture.app", host)
            if mode == "window":
                info = host / "Contents/Info.plist"
                values = plistlib.loads(info.read_bytes())
                values["SUDeltaChainHistory"] = 2
                info.write_bytes(plistlib.dumps(values))
                run("codesign", "--force", "--sign", "-", host, **quiet)
            before = (host / "Contents/Resources/data").read_bytes()
            env = os.environ.copy()
            if mode == "cancel":
                env["CHAIN_CANCEL_SECOND"] = "1"
            feed_name = mode if mode in ("corrupt", "missing") else "appcast"
            with (root / f"{mode}.log").open("w") as log:
                run(harness / "Contents/MacOS/harness", host, url + f"/{feed_name}.xml", env=env, stdout=log, stderr=log, timeout=100)
            text = (root / f"{mode}.log").read_text()
            downloads = [line for line in text.splitlines() if line.startswith("download ")]
            installed = plistlib.loads((host / "Contents/Info.plist").read_bytes())["CFBundleVersion"]
            assert text.splitlines().count("found 6") == 1, text
            if mode == "cancel":
                assert "cancelled" in text and "download 6.zip" not in text and "installed" not in text, text
                assert installed == "1" and (host / "Contents/Resources/data").read_bytes() == before
            else:
                assert installed == "6" and text.splitlines().count("installed") == 1, text
                assert (host / "Contents/Resources/data").read_bytes() == blob + b"6"
                assert downloads.count("download 6.zip") == (0 if mode == "success" else 1), text
                if mode == "success":
                    assert downloads == ["download 1-3.delta", "download 3-5.delta", "download 5-6.delta"], text
                if mode == "window":
                    assert downloads == ["download 6.zip"], text
                if mode in ("corrupt", "missing"):
                    assert downloads == ["download 1-3.delta", f"download {mode}.delta", "download 6.zip"], text
                    assert text.splitlines().count("extracting") == 1, text
                run("codesign", "--verify", "--deep", "--strict", host, **quiet)
            print(f"PASS {mode}: {', '.join(downloads)}", flush=True)
    finally:
        server.shutdown()
        key.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
