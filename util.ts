import {
  connect,
  consumerOpts,
  createInbox,
  credsAuthenticator,
  ObjectStore,
  StreamInfo,
  StringCodec,
} from "natsws";
import { NatsConf, NatsInit, NatsRes } from "./types.ts";

// NATS initialization function
export async function nats(conf: NatsInit): Promise<NatsRes> {
  const { app, dataDir, creds, token } = conf;

  const natsOpts = { servers: conf.url } as NatsConf;
  if (token) natsOpts.token = token;
  if (creds) {
    natsOpts.authenticator = credsAuthenticator(Deno.readFileSync(creds));
  }

  console.log("Connecting to NATS");
  const nc = await connect(natsOpts);
  console.log("Connected to NATS Server:", nc.getServer());

  // Generate or read the uuid for this instance
  const uid = uId(dataDir);
  console.log("Node uid:", uid);

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

  console.log(`Messages in the stream: ${stream.state.messages}`);

  // Create a jetstream client
  const js = nc.jetstream();

  console.log("Creating kv and object store if they don't exist");
  const [kv, os] = await Promise.all([js.views.kv(app), js.views.os(app)]);

  // Setup nats push consumer
  const opts = consumerOpts();
  opts.durable(uid);
  opts.manualAck();
  opts.ackExplicit();
  opts.maxAckPending(1);
  opts.deliverTo(createInbox());

  console.log("NATS initialized");

  return { sc, js, kv, os, opts, jsm, lastSeq: stream.state.messages };
}

function uId(dataDir: string): string {
  // Check if uid file exists. If not generate one with the time origin as the uid
  const name = `${dataDir}/uid`;

  if (Deno.statSync(name).isFile) {
    const uid = Deno.readTextFileSync(name);
    return uid;
  }

  const uid = String(performance.timeOrigin);
  Deno.writeTextFileSync(name, uid);
  return uid;
}

export async function restore(os: ObjectStore, db: string): Promise<void> {
  // If the file already exists, don't restore
  if (await Deno.stat(db).catch(() => false)) {
    console.log("Database already exists");
    return;
  }

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

export async function snapshot(os: ObjectStore, db: string): Promise<boolean> {
  try {
    // Put the sqlite file in the object store
    const info = await os.put({
      name: "snapshot",
      description: "Snapshot of nqlite database",
    }, readableStreamFrom(await Deno.readFile(db)));

    // Convert bytes to megabytes
    const mb = (info.size / 1024 / 1024).toFixed(2);

    console.log(`Snapshot stored in object store: ${mb}Mb`);
    return true;
  } catch (e) {
    console.log(e);
    return false;
  }
}
