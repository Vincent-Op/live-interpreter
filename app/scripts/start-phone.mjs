// Starts Metro for the dev client on the iPhone, advertising this PC's Wi-Fi address.
// (Windows also has virtual adapters such as WSL's vEthernet that Expo might pick by mistake.)
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";

const candidates = Object.entries(networkInterfaces())
  .filter(([name]) => !/vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier/i.test(name))
  .flatMap(([name, addrs]) => (addrs ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, ip: a.address })))
  .filter(({ ip }) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
const pick = candidates.find((c) => /wi-?fi|wlan/i.test(c.name)) ?? candidates[0];
if (!pick) {
  console.error("No Wi-Fi/LAN IPv4 address found. Is the PC on Wi-Fi?");
  process.exit(1);
}
console.log(`\nPhone URL: http://${pick.ip}:8081   (interface "${pick.name}")\n`);
const child = spawn(["npx expo start --dev-client --lan", ...process.argv.slice(2)].join(" "), {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, REACT_NATIVE_PACKAGER_HOSTNAME: pick.ip },
});
child.on("exit", (code) => process.exit(code ?? 0));
