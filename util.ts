import {
  connect,
  credsAuthenticator,
  ObjectStore,
  StreamInfo,
  StringCodec,
} from "natsws";
import { Database } from "sqlite3";
import { NatsConf, NatsInit, NatsRes } from "./types.ts";

// NATS initialization function
export async function nats(conf: NatsInit): Promise<NatsRes> {
  const { app, creds, token } = conf;

  const natsOpts = { servers: conf.url } as NatsConf;
  if (token) natsOpts.token = token;
  if (creds) {
    natsOpts.authenticator = credsAuthenticator(Deno.readFileSync(creds));
  }

  console.log("Connecting to NATS");
  const nc = await connect(natsOpts);
  console.log("Connected to NATS Server:", nc.getServer());

  // Create a jetstream manager
  const jsm = await nc.jetstreamManager();
  const sc = StringCodec();

  // Get the list of streams
  const streams = await jsm.streams.list().next();

  let stream = streams.find((s: StreamInfo) => s.config.name === app);

  // Create stream if it doesn't exist
  if (!stream) {
    const streamObj = {
      name: app,
      subjects: [`${app}.*`],
      num_replicas: 3,
    };

    console.log("Creating stream");
    try {
      stream = await jsm.streams.add(streamObj);
    } catch (e) {
      streamObj.num_replicas = 1;
      stream = await jsm.streams.add(streamObj);
      console.log(e);
    }
  }

  // Create a jetstream client
  const js = nc.jetstream();

  console.log("Creating object store if it don't exist");
  const os = await js.views.os(app, { replicas: 3 });

  console.log("NATS initialized");

  return { sc, js, os, jsm };
}

export async function bootstrapDataDir(dataDir: string) {
  try {
    await Deno.mkdir(dataDir, { recursive: true });
  } catch (e) {
    console.log(e.message);
    // Reset the dataDir
    await Deno.remove(dataDir, { recursive: true });
    await Deno.mkdir(dataDir, { recursive: true });
  }
}

export function dbSetup(file: string): Database {
  const db = new Database(file);

  db.exec("pragma journal_mode = WAL");
  db.exec("pragma synchronous = normal");
  db.exec("pragma temp_store = memory");

  const version = db.prepare("select sqlite_version()").value<[string]>()!;

  console.log(`SQLite version: ${version}`);

  // Create sequence table if it doesn't exist
  console.log("Creating sequence table if it doesn't exist");
  db.exec(
    `CREATE TABLE IF NOT EXISTS _nqlite_ (id INTEGER PRIMARY KEY, seq NOT NULL)`,
  );

  // Insert the first sequence number if it doesn't exist
  db.exec(`INSERT OR IGNORE INTO _nqlite_ (id, seq) VALUES (1,0)`);

  return db;
}

export async function restore(os: ObjectStore, db: string): Promise<void> {
  // See if snapshot exists in object store
  const objEntry = await os.get("snapshot");

  if (!objEntry) {
    console.log("No snapshot object to restore");
    return;
  }

  console.log("Restoring from snapshot...");

  // Get the object
  await fromReadableStream(objEntry.data, db);

  // Convert bytes to megabytes
  const mb = (objEntry.info.size / 1024 / 1024).toFixed(2);

  console.log(`Restored from snapshot: ${mb}Mb`);
}

async function fromReadableStream(
  rs: ReadableStream<Uint8Array>,
  file: string,
): Promise<void> {
  const reader = rs.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Add the chunk to the array
    if (value && value.length) {
      // Write and concat the chunks to the file
      await Deno.writeFile(file, value, { append: true });
    }
  }

  // Close the reader
  reader.releaseLock();
}

function readableStreamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // the readable stream adds data
      controller.enqueue(data);
      controller.close();
    },
  });
}

export async function snapshot(
  os: ObjectStore,
  db: string,
  seq: number,
): Promise<boolean> {
  try {
    // Put the sqlite file in the object store
    const info = await os.put({
      name: "snapshot",
      description: `${seq}`,
    }, readableStreamFrom(await Deno.readFile(db)));

    // Convert bytes to megabytes
    const mb = (info.size / 1024 / 1024).toFixed(2);

    console.log(
      `Snapshot with sequence number ${seq} stored in object store: ${mb}Mb`,
    );
    return true;
  } catch (e) {
    console.log("Error during snapshot:", e.message);
    return false;
  }
}
