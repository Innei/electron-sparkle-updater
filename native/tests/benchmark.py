#!/usr/bin/env python3
"""Time real delta-chain updates against the full-archive path on this machine."""
import argparse
import functools
import http.server
import json
import os
import plistlib
import secrets
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path

S = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
QUIET = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
MB = 1024 * 1024


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def write_app(app, identifier, version, public, blob_files, history):
    (app / "Contents/MacOS").mkdir(parents=True)
    (app / "Contents/Resources/locales").mkdir(parents=True)
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": identifier, "CFBundleName": "BenchFixture", "CFBundleExecutable": "fixture",
        "CFBundleVersion": version, "CFBundleShortVersionString": version, "CFBundlePackageType": "APPL",
        "LSMinimumSystemVersion": "12.0", "SUPublicEDKey": public, "SUFeedURL": "http://127.0.0.1/appcast.xml",
        "SUEnableAutomaticChecks": False, "SUEnableInstallerLauncherService": False, "SUDeltaChainHistory": history,
    }))
    for name, size in blob_files.items():
        with (app / "Contents/Resources" / name).open("wb") as f:
            remaining = size
            while remaining > 0:
                chunk = os.urandom(min(remaining, 8 * MB))
                f.write(chunk)
                remaining -= len(chunk)


class Chain:
    def __init__(self, root, tools, key, public, identifier, bundle_mb, delta_mb, hops, url):
        self.root, self.tools, self.key, self.url = root, tools, key, url
        self.dir = root / f"chain-{bundle_mb}mb-{delta_mb}mb"
        self.hops = hops
        base = self.dir / "0/BenchFixture.app"
        framework = max(bundle_mb - 20, 1) * MB
        files = {"framework.bin": framework, "app.asar": 20 * MB, "patch.bin": delta_mb * MB}
        files.update({f"locales/{i}.pak": 100 * 1024 for i in range(60)})
        write_app(base, identifier, "0", public, files, 32)
        run("clang", root / "fixture.c", "-o", base / "Contents/MacOS/fixture")
        run("codesign", "--force", "--sign", "-", base, **QUIET)
        self.deltas = {}
        for index in range(1, hops + 1):
            previous = self.dir / f"{index - 1}/BenchFixture.app"
            current = self.dir / f"{index}/BenchFixture.app"
            current.parent.mkdir()
            run("cp", "-Rc", previous, current)
            info = current / "Contents/Info.plist"
            values = plistlib.loads(info.read_bytes())
            values["CFBundleVersion"] = values["CFBundleShortVersionString"] = str(index)
            info.write_bytes(plistlib.dumps(values))
            (current / "Contents/Resources/patch.bin").write_bytes(os.urandom(delta_mb * MB))
            run("codesign", "--force", "--sign", "-", current, **QUIET)
            delta = self.dir / f"{index - 1}-{index}.delta"
            run(self.tools / "BinaryDelta", "create", "--version=4", previous, current, delta, **QUIET)
            self.deltas[index] = delta
        self.zip = self.dir / "full.zip"
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", self.dir / f"{hops}/BenchFixture.app", self.zip)
        self.zip_size = self.zip.stat().st_size
        self.delta_sizes = {index: delta.stat().st_size for index, delta in self.deltas.items()}
        corrupt = bytearray(self.deltas[hops].read_bytes())
        corrupt[-1] ^= 1
        (self.dir / "corrupt.delta").write_bytes(corrupt)
        self.write_appcast("appcast.xml")
        self.write_appcast("corrupt.xml", corrupt_hop=hops)
        self.write_appcast("full.xml", deltas=False)
        self.cli = self.time_cli()

    def time_cli(self):
        scratch = self.dir / "cli"
        scratch.mkdir()
        source = self.dir / f"{self.hops - 1}/BenchFixture.app"
        timings = {}
        started = time.monotonic()
        run(self.tools / "BinaryDelta", "apply", source, scratch / "patched.app", self.deltas[self.hops], **QUIET)
        timings["seconds_cli_apply"] = round(time.monotonic() - started, 3)
        started = time.monotonic()
        run("codesign", "--verify", "--strict", scratch / "patched.app", **QUIET)
        timings["seconds_cli_verify"] = round(time.monotonic() - started, 3)
        started = time.monotonic()
        run("ditto", "-x", "-k", self.zip, scratch / "unzipped")
        timings["seconds_cli_unzip"] = round(time.monotonic() - started, 3)
        run("rm", "-rf", scratch)
        return timings

    def signature(self, path):
        return subprocess.check_output([str(self.tools / "sign_update"), "--ed-key-file", str(self.key), "-p", str(path)], text=True).strip()

    def write_appcast(self, name, corrupt_hop=None, deltas=True):
        prefix = f"{self.url}/{self.dir.name}"
        feed = ET.Element("rss", {"version": "2.0"})
        channel = ET.SubElement(feed, "channel")
        zip_signature = self.signature(self.zip)
        for index in range(self.hops, -1, -1):
            item = ET.SubElement(channel, "item")
            ET.SubElement(item, S + "version").text = str(index)
            ET.SubElement(item, "enclosure", {"url": f"{prefix}/full.zip", "length": str(self.zip_size), S + "edSignature": zip_signature})
            if index == 0 or not deltas:
                continue
            delta = self.deltas[index]
            file_name = "corrupt.delta" if index == corrupt_hop else delta.name
            ET.SubElement(ET.SubElement(item, S + "deltas"), "enclosure", {
                "url": f"{prefix}/{file_name}", "length": str(self.delta_sizes[index]), S + "deltaFrom": str(index - 1), S + "edSignature": self.signature(delta),
            })
        ET.ElementTree(feed).write(self.dir / name, xml_declaration=True, encoding="utf-8")


def run_update(harness, chain, installed, feed, label):
    host_dir = chain.root / "installed" / label
    host = host_dir / "BenchFixture.app"
    host_dir.mkdir(parents=True)
    run("cp", "-Rc", chain.dir / f"{installed}/BenchFixture.app", host)
    env = dict(os.environ, CHAIN_TIMEOUT_SECONDS="600")
    process = subprocess.Popen([str(harness / "Contents/MacOS/harness"), str(host), f"{chain.url}/{chain.dir.name}/{feed}"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    start = time.monotonic()
    events = []
    for line in process.stdout:
        events.append((time.monotonic() - start, line.rstrip("\n")))
    process.wait()
    stamps, last = {}, {}
    downloads = []
    for at, event in events:
        stamps.setdefault(event, at)
        last[event] = at
        if event.startswith("download "):
            downloads.append(event[len("download "):])
    installed_now = plistlib.loads((host / "Contents/Info.plist").read_bytes())["CFBundleVersion"]
    result = {
        "label": label, "exit": process.returncode, "installed_version": installed_now, "downloads": downloads,
        "download_bytes": sum(chain.zip_size if name == "full.zip" else chain.delta_sizes[chain.hops if name == "corrupt.delta" else int(name.split("-")[1].split(".")[0])] for name in downloads),
        "seconds_download": round(stamps.get("extracting", 0) - stamps.get("download-start", 0), 3),
        "seconds_apply": round(stamps.get("installing", 0) - last.get("extracting", 0), 3),
        "seconds_total": round(stamps.get("installing", 0) - stamps.get("found " + str(chain.hops), 0), 3),
    }
    result.update(chain.cli)
    (chain.root / f"{label}.log").write_text("".join(f"{at:8.3f} {event}\n" for at, event in events))
    if process.returncode != 0:
        result["log"] = [event for _, event in events]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--framework", required=True, type=Path)
    parser.add_argument("--tools", required=True, type=Path)
    parser.add_argument("--bundle-mb", type=int, nargs="+", default=[250])
    parser.add_argument("--delta-mb", type=int, nargs="+", default=[1, 5, 20])
    parser.add_argument("--hops", type=int, nargs="+", default=[1, 5, 10, 20])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="sparkle-chain-benchmark-"))
    print(f"Fixtures and logs: {root}", flush=True)
    key, public = root / "key", root / "public"
    run("swift", "-e", 'import CryptoKit; import Foundation; let k = Curve25519.Signing.PrivateKey(); try k.rawRepresentation.base64EncodedString().write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8); try k.publicKey.rawRepresentation.base64EncodedString().write(toFile: CommandLine.arguments[2], atomically: true, encoding: .utf8)', key, public)
    key.chmod(0o600)
    identifier = "dev.innei.bench-fixture." + secrets.token_hex(6)
    (root / "fixture.c").write_text("int main(void) { return 0; }")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"

    harness = root / "Harness.app"
    (harness / "Contents/MacOS").mkdir(parents=True)
    (harness / "Contents/Frameworks").mkdir()
    run("ditto", args.framework, harness / "Contents/Frameworks/Sparkle.framework")
    (harness / "Contents/Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": identifier + ".harness", "CFBundleExecutable": "harness", "CFBundleVersion": "1",
        "CFBundleName": "BenchHarness", "CFBundlePackageType": "APPL", "LSUIElement": True,
        "SUEnableDownloaderService": False, "SUEnableInstallerLauncherService": False,
    }))
    run("clang", "-fobjc-arc", "-framework", "AppKit", "-framework", "Sparkle", "-F" + str(harness / "Contents/Frameworks"),
        "-Wl,-rpath,@executable_path/../Frameworks", Path(__file__).with_name("updater-harness.m"), "-o", harness / "Contents/MacOS/harness")
    run("codesign", "--force", "--deep", "--sign", "-", harness, **QUIET)

    results = []
    def record(result, **fields):
        result.update(fields)
        results.append(result)
        print(json.dumps(result), flush=True)
        if args.output:
            args.output.write_text("\n".join(json.dumps(r) for r in results) + "\n")

    try:
        max_hops = max(args.hops)
        for bundle_mb in args.bundle_mb:
            for delta_mb in args.delta_mb:
                started = time.monotonic()
                chain = Chain(root, args.tools, key, public.read_text(), identifier, bundle_mb, delta_mb, max_hops, url)
                print(f"generated {bundle_mb}MB bundle / {delta_mb}MB deltas x {max_hops} in {time.monotonic() - started:.1f}s; zip={chain.zip_size / MB:.1f}MB delta={chain.delta_sizes[1] / MB:.2f}MB", flush=True)
                common = {"bundle_mb": bundle_mb, "delta_mb": delta_mb, "zip_bytes": chain.zip_size, "delta_bytes": chain.delta_sizes[1]}
                record(run_update(harness, chain, str(max_hops - 1), "full.xml", f"full-{bundle_mb}-{delta_mb}"), mode="full", hops=0, **common)
                for hops in args.hops:
                    record(run_update(harness, chain, str(max_hops - hops), "appcast.xml", f"chain-{bundle_mb}-{delta_mb}-{hops}"), mode="chain", hops=hops, **common)
                record(run_update(harness, chain, str(max_hops - max_hops // 2), "corrupt.xml", f"corrupt-{bundle_mb}-{delta_mb}"), mode="corrupt-last-hop", hops=max_hops // 2, **common)
                run("rm", "-rf", chain.dir, root / "installed")
    finally:
        server.shutdown()
        key.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
