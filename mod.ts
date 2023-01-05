import {
  Codec,
  consumerOpts,
  createInbox,
  JetStreamClient,
  JetStreamManager,
  JetStreamSubscription,
  ObjectStore,
  PubAck,
  StringCodec,
} from "natsws";
import { serve } from "serve";
import { Context, Hono } from "hono";
import { bootstrapDataDir, dbSetup, nats, restore, snapshot } from "./util.ts";
import { Database } from "sqlite3";
import { NatsRes, Options, ParseRes, Res } from "./types.ts";
import { parse } from "./parse.ts";

export class Nqlite {
  dataDir!: string;
  dbFile!: string;
  sc: Codec<string> = StringCodec();
  app: string;
  js!: JetStreamClient;
  db!: Database;
  os!: ObjectStore;
  subject: string;
  sub!: JetStreamSubscription;
  snapInterval: number;
  snapThreshold: number;
  jsm!: JetStreamManager;

  // Create a constructor
  constructor() {
    this.app = "nqlite";
    this.subject = `${this.app}.push`;
    this.snapInterval = 2;
    this.snapThreshold = 1024;
  }

  // Init function to connect to NATS
  async init(opts: Options): Promise<void> {
    const { url, creds, token, dataDir } = opts;

    this.dataDir = `${dataDir}/${this.app}`;
    this.dbFile = `${this.dataDir}/nqlite.db`;

    // Bootstrap the dataDir
    await bootstrapDataDir(this.dataDir);

    // Initialize NATS
    const res: NatsRes = await nats({ url, app: this.app, creds, token });
    ({ js: this.js, os: this.os, jsm: this.jsm } = res);

    // Restore from snapshot if exists
    await restore(this.os, this.dbFile);

    // Setup to the database
    this.db = dbSetup(this.dbFile);

    // Setup the API
    this.http();

    // Start snapshot poller
    this.snapshotPoller();

    // Start iterating over the messages in the stream
    await this.consumer();

    // Handle SIGINT
    Deno.addSignalListener("SIGINT", async () => {
      console.log("About to die! Draining subscription...");
      await this.sub.drain();
      console.log("Closing the database");
      this.db.close();
      console.log("Removing the data directory");
      await Deno.remove(this.dataDir, { recursive: true });
      Deno.exit();
    });
  }

  // Get the latest sequence number
  getSeq(): number {
    return this.db.prepare(`SELECT seq FROM _nqlite_`).get()!.seq as number;
  }

  // Set the latest sequence number
  setSeq(seq: number): void {
    this.db.prepare(`UPDATE _nqlite_ SET seq = ? where id = 1`).run(seq);
  }

  // Execute a statement
  execute(s: ParseRes): Res {
    const res: Res = { results: [{}], time: 0 };

    // Check for error
    if (s.error) {
      res.results[0].error = s.error;
      res.time = performance.now() - s.t;
      return res;
    }

    // Check for simple bulk query
    if (s.bulkItems.length && s.simple) {
      for (const p of s.bulkItems) this.db.exec(p);
      res.time = performance.now() - s.t;
      res.results[0].last_insert_id = this.db.lastInsertRowId;
      return res;
    }

    // Check for bulk paramaterized/named query
    if (s.bulkParams.length) {
      for (const p of s.bulkParams) this.db.prepare(p.query).run(...p.params);
      res.results[0].last_insert_id = this.db.lastInsertRowId;
      res.time = performance.now() - s.t;
      return res;
    }

    const stmt = this.db.prepare(s.query);

    // If this is a read statement set the last last_insert_id and rows_affected
    if (s.isRead) {
      res.results[0].rows = s.simple ? stmt.all() : stmt.all(...s.params);
      res.time = performance.now() - s.t;
      return res;
    }

    // Must not be a read statement
    res.results[0].rows_affected = s.simple
      ? stmt.run()
      : stmt.run(...s.params);
    res.results[0].last_insert_id = this.db.lastInsertRowId;
    res.time = performance.now() - s.t;
    return res;
  }

  // Setup ephemeral consumer
  async consumer(): Promise<void> {
    // Get the latest sequence number
    const opts = consumerOpts();
    opts.manualAck();
    opts.ackExplicit();
    opts.maxAckPending(10);
    opts.deliverTo(createInbox());

    const seq = this.getSeq() + 1;
    opts.startSequence(seq);

    // Get the latest sequence number in the stream
    const s = await this.jsm.streams.info(this.app);

    console.log("Messages in the stream  ->>", s.state.messages);
    console.log("Starting sequence       ->>", seq);
    console.log("Last sequence in stream ->>", s.state.last_seq);

    this.sub = await this.js.subscribe(this.subject, opts);
    this.iterator(this.sub, s.state.last_seq);
  }

  // Publish a message to NATS
  async publish(s: ParseRes): Promise<Res> {
    const res: Res = { results: [{}], time: 0 };

    // Check for error
    if (s.error) {
      res.error = s.error;
      res.time = performance.now() - s.t;
      return res;
    }

    // Publish the message
    const pub: PubAck = await this.js.publish(
      this.subject,
      this.sc.encode(JSON.stringify(s.data)),
    );
    res.results[0].nats = pub;
    res.time = performance.now() - s.t;
    return res;
  }

  // Handle NATS push consumer messages
  async iterator(sub: JetStreamSubscription, lastSeq?: number) {
    for await (const m of sub) {
      const data = JSON.parse(this.sc.decode(m.data));

      try {
        const res = parse(data, performance.now());

        // Handle errors
        if (res.error) {
          console.log("Parse error:", res.error);
          m.ack();
          continue;
        }

        this.execute(res);
      } catch (e) {
        console.log("Execute error: ", e.message, "Query: ", data);
      }

      m.ack();
      this.setSeq(m.seq);

      // Check for last sequence
      if (lastSeq) {
        if (m.seq === lastSeq) {
          console.log("Caught up to last msg   ->>", lastSeq);
        }
      }
    }
  }

  // Snapshot poller
  async snapshotPoller() {
    console.log("Starting snapshot poller");
    while (true) {
      // Wait for the interval to pass
      await new Promise((resolve) =>
        setTimeout(resolve, this.snapInterval * 60 * 60 * 1000)
      );

      try {
        // First VACUUM the database to free up space
        this.db.exec("VACUUM");

        // Check object store for snapshot
        const snapInfo = await this.os.info(this.app);

        // Check if we need to snapshot
        if (snapInfo) {
          const processed = this.getSeq() - Number(snapInfo.description);
          if (processed < this.snapThreshold) {
            console.log(
              `Skipping snapshot, threshold not met: ${processed} < ${this.snapThreshold}`,
            );
            continue;
          }
        }

        if (!snapInfo && this.getSeq() < this.snapThreshold) {
          console.log(
            `Skipping snapshot, threshold not met: ${this.getSeq()} < ${this.snapThreshold}`,
          );
          continue;
        }

        // Unsubscribe from the stream so we stop receiving db updates
        await this.sub.drain();
        console.log("Drained subscription...");

        // Snapshot the database to object store
        let seq = this.getSeq();
        if (await snapshot(this.os, this.dbFile, seq)) {
          // Purge previos messages from the stream older than seq - snapThreshold
          seq = seq - this.snapThreshold;
          await this.jsm.streams.purge(this.app, {
            filter: this.subject,
            seq: seq < 0 ? 0 : seq,
          });
        }
      } catch (e) {
        console.log("Error during snapshot polling:", e.message);
      }

      // Resubscribe to the stream
      console.log(`Subscribing to stream after snapshot attempt`);
      await this.consumer();
    }
  }

  // Handle API Routing
  http() {
    const api = new Hono();

    // GET /db/query
    api.get("/db/query", (c: Context): Response => {
      const res: Res = { results: [{}], time: 0 };
      const perf = performance.now();

      if (!c.req.query("q")) {
        res.results[0].error = "Missing query";
        return c.json(res, 400);
      }

      const arr = new Array<string>();
      arr.push(c.req.query("q")!);

      // turn arr to JSON type
      const r = JSON.stringify(arr);

      try {
        const data = parse(JSON.parse(r), perf);
        return c.json(this.execute(data));
      } catch (e) {
        if (e instanceof Error) {
          res.results[0].error = e.message;
          return c.json(res, 400);
        }
        res.results[0].error = "Invalid Query";
        return c.json(res, 400);
      }
    });

    // POST /db/query
    api.post("/db/query", async (c: Context): Promise<Response> => {
      const res: Res = { results: [{}], time: 0 };
      const perf = performance.now();

      if (!c.req.body) {
        res.results[0].error = "Missing body";
        return c.json(res, 400);
      }

      try {
        // data should be an array of SQL statements or a multidimensional array of SQL statements
        const data = parse(await c.req.json(), perf);

        // Handle errors
        if (data.error) {
          res.results[0].error = data.error;
          return c.json(res, 400);
        }

        return data.isRead
          ? c.json(this.execute(data))
          : c.json(await this.publish(data));
      } catch (e) {
        if (e instanceof Error) {
          res.results[0].error = e.message;
          return c.json(res, 400);
        }
        res.results[0].error = "Invalid Query";
        return c.json(res, 400);
      }
    });

    // Serve the API on port 4001
    serve(api.fetch, { port: 4001 });
  }
}

export type { Options };
