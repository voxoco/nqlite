import { parse } from "https://deno.land/std@0.168.0/flags/mod.ts";

const flags = parse(Deno.args, {
  boolean: ["help"],
  string: ["wshost", "creds", "token", "data-dir"],
  alias: { h: "help" },
  stopEarly: true,
  default: {
    help: false,
    wshost: "ws://localhost:8080",
    creds: "",
    token: "",
    "data-dir": ".data",
  },
});

const showHelp = () => {
  console.log("Usage: ./nqlite [options]");
  console.log("  --help, -h: Show this help");
  console.log(
    "  --wshost: NATS websocket server URL (default: 'ws://localhost:8080')",
  );
  console.log("  --token: NATS authentication token (default: none)");
  console.log("  --creds: NATS credentials file (default: none)");
  console.log("  --data-dir: Data directory (default: '.data'");
  Deno.exit(0);
};

if (flags.help) showHelp();

// If no credentials or token are provided, proceed without authentication
if (!flags.creds && !flags.token) {
  console.log(
    "Warning: no credentials or token provided. Proceeding without authentication",
  );
}

// If both credentials and token are provided, exit
if (flags.creds && flags.token) {
  console.log(
    "Error: both credentials and token provided. Please provide only one",
  );
  showHelp();
}

import { Nqlite } from "./mod.ts";

// Startup nqlite
const nqlite = new Nqlite();
await nqlite.init(flags["wshost"], flags["creds"], flags["token"], flags["data-dir"]);
