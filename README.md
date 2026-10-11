# dsk

`df -h` dumps tmpfs and splits one disk across rows. `dsk` groups by device and leads with free space.

Linux only. Reads `/proc/self/mounts`.

```
287 GB free  ·  WD PC SN810 SDCPNRY-512G-1006 (nvme0n1p3)  ·  /  /home
█████████░░░░░░░░░░░░░  39% used of 474 GB

371 GB free  ·  Tech (sda1)  ·  /mnt/immich-media
███░░░░░░░░░░░░░░░░░░░  15% used of 457 GB
```

## Install

Node 20+.

```bash
git clone git@github.com:utpalsinghdev/dsk.git
cd dsk
npm install
npm run build
npm install -g .
```

Uninstall: `npm uninstall -g dsk`

## Usage

```bash
dsk                 real disks, free space first
dsk /home           filesystem that holds that path
dsk --json          machine-readable bytes
dsk --plain         TSV: device mount extra-mounts fstype size used avail percent
dsk --all           include tmpfs and other virtual mounts
```

`-h` / `--help`, `--version`, `--no-color`.

Respects `NO_COLOR` and `TERM=dumb`.

## License

MIT
