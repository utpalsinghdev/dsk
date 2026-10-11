#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { dirname } from "node:path";

const VERSION = "1.0.0";

const VIRTUAL_FS = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "overlay",
  "proc",
  "pstore",
  "ramfs",
  "rpc_pipefs",
  "securityfs",
  "squashfs",
  "sysfs",
  "tmpfs",
  "tracefs",
]);

type Mode = "human" | "json" | "plain";

type Args = {
  help: boolean;
  version: boolean;
  all: boolean;
  noColor: boolean;
  mode: Mode;
  paths: string[];
};

type Mount = {
  device: string;
  mount: string;
  fstype: string;
};

type Volume = {
  device: string;
  fstype: string;
  mounts: string[];
  size: number;
  used: number;
  avail: number;
  percent: number;
  model: string | null;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    version: false,
    all: false,
    noColor: false,
    mode: "human",
    paths: [],
  };

  if (argv.includes("-h") || argv.includes("--help")) {
    args.help = true;
    return args;
  }

  let rest = false;
  for (const a of argv) {
    if (!rest) {
      if (a === "--") {
        rest = true;
        continue;
      }
      if (a === "--version") {
        args.version = true;
        continue;
      }
      if (a === "-a" || a === "--all") {
        args.all = true;
        continue;
      }
      if (a === "--no-color") {
        args.noColor = true;
        continue;
      }
      if (a === "--json") {
        if (args.mode !== "human" && args.mode !== "json") {
          throw new UsageError("use only one of --json or --plain");
        }
        args.mode = "json";
        continue;
      }
      if (a === "--plain") {
        if (args.mode !== "human" && args.mode !== "plain") {
          throw new UsageError("use only one of --json or --plain");
        }
        args.mode = "plain";
        continue;
      }
      if (a.startsWith("-")) {
        throw new UsageError(`unknown flag: ${a}`);
      }
    }
    args.paths.push(a);
  }

  return args;
}

function helpText(): string {
  return `Show free disk space, without the df noise.

Usage:
  dsk [path ...]
  dsk --json
  dsk --all

Examples:
  dsk                 real disks, free space first
  dsk /home           filesystem that holds that path
  dsk --json          machine-readable bytes
  dsk --plain         TSV: device mount extra-mounts fstype size used avail percent
  dsk --all           include tmpfs and other virtual mounts

Flags:
  -a, --all
      --json
      --plain
      --no-color
      --version
  -h, --help
`;
}

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, oct: string) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  );
}

function readMounts(): Mount[] {
  const raw = readFileSync("/proc/self/mounts", "utf8");
  const mounts: Mount[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    const device = unescapeMount(parts[0]!);
    const mount = unescapeMount(parts[1]!);
    const fstype = parts[2]!;
    mounts.push({ device, mount, fstype });
  }
  return mounts;
}

function isVirtual(m: Mount): boolean {
  if (VIRTUAL_FS.has(m.fstype)) return true;
  if (m.device === "none" || m.device === "overlay") return true;
  if (
    m.mount === "/boot/efi" ||
    m.mount.startsWith("/sys/") ||
    m.mount.startsWith("/proc/") ||
    m.mount.startsWith("/dev/") ||
    m.mount.startsWith("/run/") ||
    m.mount.startsWith("/snap/")
  ) {
    return true;
  }
  return false;
}

function blockName(device: string): string | null {
  if (!device.startsWith("/dev/")) return null;
  const base = device.slice("/dev/".length);
  const nvme = base.match(/^(nvme\d+n\d+)p\d+$/);
  if (nvme) return nvme[1]!;
  const sd = base.match(/^([a-z]+)\d+$/);
  if (sd) return sd[1]!;
  return base;
}

function diskModel(device: string): string | null {
  const block = blockName(device);
  if (!block) return null;
  const path = `/sys/block/${block}/device/model`;
  if (!existsSync(path)) return null;
  const model = readFileSync(path, "utf8").trim();
  return model || null;
}

function collect(mounts: Mount[]): Volume[] {
  // btrfs subvols get different st_dev; group by kernel device path instead
  const byDevice = new Map<string, Volume>();

  for (const m of mounts) {
    let fs;
    try {
      fs = statfsSync(m.mount);
    } catch {
      continue;
    }

    const existing = byDevice.get(m.device);
    if (existing) {
      if (!existing.mounts.includes(m.mount)) existing.mounts.push(m.mount);
      continue;
    }

    const size = fs.blocks * fs.bsize;
    const used = (fs.blocks - fs.bfree) * fs.bsize;
    const avail = fs.bavail * fs.bsize;
    const capacity = used + avail;
    const percent = capacity === 0 ? 0 : (used / capacity) * 100;

    byDevice.set(m.device, {
      device: m.device,
      fstype: m.fstype,
      mounts: [m.mount],
      size,
      used,
      avail,
      percent,
      model: diskModel(m.device),
    });
  }

  for (const v of byDevice.values()) {
    v.mounts.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }

  return [...byDevice.values()].sort((a, b) => b.size - a.size);
}

function mountForPath(path: string, mounts: Mount[]): string {
  if (!existsSync(path)) {
    throw new Error(`no such path: ${path}`);
  }
  let p = realpathSync(path);
  const set = new Set(mounts.map((m) => m.mount));
  while (!set.has(p)) {
    const parent = dirname(p);
    if (parent === p) return "/";
    p = parent;
  }
  return p;
}

function fmtBytes(bytes: number): string {
  const n = Math.max(0, bytes);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)} ${units[i]}`;
  const digits = v >= 10 ? 0 : 1;
  return `${v.toFixed(digits).replace(/\.0$/, "")} ${units[i]}`;
}

function bar(percent: number, width = 22): string {
  const pct = Math.min(100, Math.max(0, percent));
  const filled = Math.round((pct / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function colorEnabled(args: Args): boolean {
  if (args.noColor) return false;
  if (args.mode !== "human") return false;
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  return true;
}

function paint(enabled: boolean, code: string, text: string): string {
  if (!enabled) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function tone(percent: number): string {
  if (percent >= 90) return "31";
  if (percent >= 75) return "33";
  return "32";
}

function deviceLabel(v: Volume): string {
  const base = v.device.startsWith("/dev/") ? v.device.slice("/dev/".length) : v.device;
  return v.model ? `${v.model} (${base})` : base;
}

function printHuman(volumes: Volume[], color: boolean): void {
  if (volumes.length === 0) {
    process.stderr.write("no filesystems to show\n");
    return;
  }

  const blocks = volumes.map((v) => {
    const coloredFree = paint(color, `${tone(v.percent)};1`, fmtBytes(v.avail));
    const label = paint(color, "2", deviceLabel(v));
    const mounts = v.mounts.join("  ");
    const usedBar = paint(color, tone(v.percent), bar(v.percent));
    const pct = `${Math.round(v.percent)}% used`;
    const line1 = `${coloredFree} free  ·  ${label}  ·  ${mounts}`;
    const line2 = `${usedBar}  ${paint(color, "2", `${pct} of ${fmtBytes(v.size)}`)}`;
    return `${line1}\n${line2}`;
  });

  process.stdout.write(`${blocks.join("\n\n")}\n`);
}

function printJson(volumes: Volume[]): void {
  const payload = volumes.map((v) => ({
    device: v.device,
    model: v.model,
    fstype: v.fstype,
    mounts: v.mounts,
    size: v.size,
    used: v.used,
    avail: v.avail,
    percent: Math.round(v.percent * 10) / 10,
  }));
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printPlain(volumes: Volume[]): void {
  for (const v of volumes) {
    const mount = v.mounts[0] ?? "";
    const extra = v.mounts.slice(1).join(",");
    const cols = [
      v.device,
      mount,
      extra,
      v.fstype,
      String(v.size),
      String(v.used),
      String(v.avail),
      v.percent.toFixed(1),
    ];
    process.stdout.write(`${cols.join("\t")}\n`);
  }
}

function main(): number {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\ntry: dsk --help\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (!existsSync("/proc/self/mounts")) {
    process.stderr.write("dsk reads /proc/self/mounts (Linux only)\n");
    return 1;
  }

  let mounts: Mount[];
  try {
    mounts = readMounts();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cannot read mounts: ${message}\n`);
    return 1;
  }

  if (args.paths.length > 0) {
    const wanted = new Set<string>();
    try {
      for (const p of args.paths) wanted.add(mountForPath(p, mounts));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      return 1;
    }
    mounts = mounts.filter((m) => wanted.has(m.mount));
  } else if (!args.all) {
    mounts = mounts.filter((m) => !isVirtual(m));
  }

  const volumes = collect(mounts);
  if (args.mode === "json") printJson(volumes);
  else if (args.mode === "plain") printPlain(volumes);
  else printHuman(volumes, colorEnabled(args));

  return volumes.length === 0 && args.mode === "human" ? 1 : 0;
}

process.exitCode = main();
