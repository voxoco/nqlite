import {
  connect,
  credsAuthenticator,
  JetStreamSubscription,
  ObjectStore,
  StreamInfo,
  StringCodec,
} from "nats";
import { connect as wsConnect } from "natsws";
import { Database } from "sqlite3";
import { NatsConf, NatsInit, NatsRes } from "./types.ts";

// NATS initialization function
export async function setupNats(conf: NatsInit): Promise<NatsRes> {
  const { app, creds, token, url } = conf;

  const natsOpts: NatsConf = { servers: url, maxReconnectAttempts: -1 };
  if (token) natsOpts.token = token;
  if (creds) {
    natsOpts.authenticator = credsAuthenticator(Deno.readFileSync(creds));
  }

  console.log("Connecting to NATS");
  const nc = url.startsWith("ws")
    ? await wsConnect(natsOpts)
    : await connect(natsOpts);
  console.log("Connected to NATS Server:", nc.getServer());

  // Create a jetstream manager
  const jsm = await nc.jetstreamManager();
  const sc = StringCodec();

  // Get the list of streams
  const streams = await jsm.streams.list().next();

  let stream = streams.find((s: StreamInfo) => s.config.name === app);

  // Create stream if it doesn't exist
  if (!stream) {
    console.log("Creating stream");
    stream = await jsm.streams.add({ name: app, subjects: [`${app}.*`] });

    // Try to update the stream to 3 replicas
    try {
      await jsm.streams.update(app, { num_replicas: 3 });
    } catch (e) {
      console.log("Could not update stream to 3 replicas:", e.message);
    }
  }

  // Create a jetstream client
  const js = nc.jetstream();

  console.log("Creating object store if it don't exist");
  const os = await js.views.os(app);

  // Try to update the object store to 3 replicas
  try {
    await jsm.streams.update(`OBJ_${app}`, { num_replicas: 3 });
  } catch (e) {
    console.log("Could not update object store to 3 replicas:", e.message);
  }

  console.log("NATS initialized");

  return { nc, sc, js, os, jsm };
}

export async function bootstrapDataDir(dataDir: string) {
  console.log("Bootstrapping data directory:", dataDir);

  try {
    await Deno.remove(dataDir, { recursive: true });
  } catch (e) {
    console.log(e.message);
  }

  try {
    await Deno.mkdir(dataDir, { recursive: true });
  } catch (e) {
    console.log(e.message);
  }
}

export function setupDb(file: string): Database {
  const db = new Database(file);

  db.exec("pragma locking_mode = exclusive");
  db.exec("pragma auto_vacuum = none");
  db.exec("pragma journal_mode = wal");
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

export async function restore(os: ObjectStore, db: string): Promise<boolean> {
  // See if snapshot exists in object store
  const o = await os.get("snapshot");

  if (!o) {
    console.log("No snapshot object to restore");
    return false;
  }

  console.log(
    `Restoring from snapshot taken: ${o.info.mtime}`,
  );

  // Get the object
  await fromReadableStream(o.data, db);

  // Convert bytes to megabytes
  const mb = (o.info.size / 1024 / 1024).toFixed(2);

  console.log(`Restored from snapshot: ${mb}Mb`);
  return true;
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
): Promise<boolean> {
  try {
    // Put the sqlite file in the object store
    const info = await os.put(
      { name: "snapshot" },
      readableStreamFrom(Deno.readFileSync(db)),
    );

    // Convert bytes to megabytes
    const mb = (info.size / 1024 / 1024).toFixed(2);

    console.log(
      `Snapshot stored in object store: ${mb}Mb`,
    );
    return true;
  } catch (e) {
    console.log("Error during snapshot:", e.message);
    return false;
  }
}

export async function snapshotCheck(
  os: ObjectStore,
  seq: number,
  threshold: number,
): Promise<boolean> {
  console.log(
    `Checking if we need to snapshot (seq: ${seq}, threshold: ${threshold})`,
  );

  try {
    const snapInfo = await os.info("snapshot");

    if (!snapInfo) console.log("No snapshot found in object store");

    // Check if we need to snapshot
    if (snapInfo) {
      const processed = seq - Number(snapInfo.description);
      console.log("Messages processed since last snapshot ->", processed);
      if (processed < threshold) {
        console.log(
          `Skipping snapshot, threshold not met: ${processed} < ${threshold}`,
        );
        return false;
      }

      // Check if another is in progress or created in the last minute
      const now = new Date().getTime();
      const last = new Date(snapInfo.mtime).getTime();
      if (now - last < 60 * 1000) {
        const diff = Math.floor((now - last) / 1000);
        console.log(`Skipping snapshot, latest snapshot ${diff} seconds ago`);
        return false;
      }
    }

    // Check if no snapshot exists and we are below the threshold
    if (!snapInfo && seq < threshold) {
      console.log(
        `Skipping snapshot, threshold not met: ${seq} < ${threshold}`,
      );
      return false;
    }
  } catch (e) {
    console.log("Error during snapshot check:", e.message);
    return false;
  }

  return true;
}

export async function httpBackup(db: string, url: string): Promise<boolean> {
  // Backup to HTTP using the fetch API
  try {
    const res = await fetch(url, {
      method: "POST",
      body: Deno.readFileSync(db),
    });
    console.log("HTTP backup response:", res.status, res.statusText);
    if (res.status !== 200) return false;
    const mb = (Deno.statSync(db).size / 1024 / 1024).toFixed(2);
    console.log(`Snapshot stored via http: ${mb}Mb`);
    return true;
  } catch (e) {
    console.log("Error during http backup:", e.message);
    return false;
  }
}

export async function httpRestore(db: string, url: string): Promise<boolean> {
  // Restore from HTTP using the fetch API
  try {
    const res = await fetch(url);
    console.log("HTTP restore response:", res.status, res.statusText);
    if (res.status !== 200) return false;
    const file = await Deno.open(db, { write: true, create: true });
    await res.body?.pipeTo(file.writable);
    const mb = (Deno.statSync(db).size / 1024 / 1024).toFixed(2);
    console.log(`Restored from http snapshot: ${mb}Mb`);
    return true;
  } catch (e) {
    console.log("Error during http restore:", e.message);
    return false;
  }
}

export async function sigHandler(
  inSnap: boolean,
  sub: JetStreamSubscription,
  db: Database,
): Promise<void> {
  // Check if inSnapShot is true
  if (inSnap) {
    console.log("SIGINT received while in snapshot. Waiting 10 seconds...");
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  console.log("About to die! Draining subscription...");
  await sub.drain();
  await sub.destroy();
  console.log("Closing the database");
  db.close();
  Deno.exit();
}
