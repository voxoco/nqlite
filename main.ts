import { parse } from "https://deno.land/std@0.168.0/flags/mod.ts";

const flags = parse(Deno.args, {
  boolean: ["help"],
  string: ["nats-host", "creds", "token", "data-dir"],
  alias: { h: "help" },
  stopEarly: true,
  default: {
    help: false,
    "nats-host": "",
    creds: "",
    token: "",
    "data-dir": ".nqlite-data",
  },
});

const showHelp = () => {
  console.log("Usage: ./nqlite [options]");
  console.log("    --help, -h: Show this help");
  console.log(
    "    --nats-host: NATS host e.g 'nats://localhost:4222' || 'ws://localhost:8080' (required)",
  );
  console.log(
    "    --token: NATS authentication token (required if --creds is not provided)",
  );
  console.log(
    "    --creds: NATS credentials file (required if --token is not provided)",
  );
  console.log("    --data-dir: Data directory (default: '.data'");
  Deno.exit(0);
};

if (flags.help) showHelp();

// If no credentials or token are provided, proceed without authentication
if (!flags.creds && !flags.token) {
  console.log(
    "Warning: no --creds or --token provided. Proceeding without authentication",
  );
}

// If both credentials and token are provided, exit
if (flags.creds && flags.token) {
  console.log(
    "Error: both --creds and --token provided. Please provide only one",
  );
  showHelp();
}

// Make sure nats-host is provided
if (!flags["nats-host"]) {
  console.log("Error: --nats-host is required");
  showHelp();
}

import { Nqlite, Options } from "./mod.ts";

// Startup nqlite
const nqlite = new Nqlite();

const opts: Options = {
  url: flags["nats-host"],
  creds: flags["creds"],
  token: flags["token"],
  dataDir: flags["data-dir"],
};

await nqlite.init(opts);
