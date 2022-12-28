import {
  Codec,
  ConsumerOptsBuilder,
  JetStreamClient,
  JetStreamManager,
  JetStreamSubscription,
  KV,
  NatsConnection,
  ObjectStore,
  PubAck,
  StringCodec,
} from "natsws";
import { serve } from "serve";
import { Context, Hono } from "hono";
import { nats, restore, snapshot } from "./util.ts";
import { Database } from "sqlite3";
import { NatsInit, NatsRes, ParseRes, Res } from "./types.ts";
import { parse } from "./parse.ts";

export class Nqlite {
  dataDir!: string;
  dbFile!: string;
  nc!: NatsConnection;
  sc: Codec<string> = StringCodec();
  app: string;
  js!: JetStreamClient;
  db!: Database;
  os!: ObjectStore;
  kv!: KV;
  subject: string;
  sub!: JetStreamSubscription;
  opts!: ConsumerOptsBuilder;
  snapInterval: number;
  snapThreshold: number;
  seq: number;
  jsm!: JetStreamManager;

  // Create a constructor
  constructor() {
    this.app = "nqlite";
    this.subject = `${this.app}.push`;
    this.snapInterval = 2;
    this.snapThreshold = 1024;
    this.seq = 0;
  }

  // Init function to connect to NATS
  async init(url: string, creds: string, token: string, dataDir: string): Promise<void> {
    // Make sure directory exists
    this.dataDir = dataDir;
    this.dbFile = `${this.dataDir}/nqlite.db`;
    await Deno.mkdir(this.dataDir, { recursive: true });

    // NATS connection options
    const conf = {
      url,
      app: this.app,
      dataDir: this.dataDir,
      creds,
      token,
    } as NatsInit;

    // Initialize NATS
    const res: NatsRes = await nats(conf);
    ({
      js: this.js,
      os: this.os,
      kv: this.kv,
      opts: this.opts,
      jsm: this.jsm,
      lastSeq: this.seq,
    } = res);

    // Restore from snapshot if needed
    await restore(this.os, this.dbFile);

    // Connect to the database
    this.db = new Database(this.dbFile);

    const version = this.db.prepare("select sqlite_version()").value<
      [string]
    >()!;
    console.log(`SQLite version: ${version}`);

    // Setup the API
    this.http();

    // Start snapshot poller
    this.snapshotPoller();

    // Start iterating over the messages in the stream
    this.sub = await this.js.subscribe(this.subject, this.opts);
    this.iterator(this.sub);
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

    // Check for transaction
    if (s.txItems.length) {
      let changes = 0;
      for (const p of s.txItems) {
        this.db.exec(p);
        changes += this.db.changes;
      }
      res.results[0].rows_affected = changes;
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
      ? stmt.all()
      : stmt.all(...s.params);
    res.results[0].last_insert_id = this.db.lastInsertRowId;
    res.time = performance.now() - s.t;
    return res;
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
  async iterator(sub: JetStreamSubscription) {
    for await (const m of sub) {
      console.log(`Received sequence #: ${m.seq}`);

      try {
        const res = parse(
          JSON.parse(this.sc.decode(m.data)),
          performance.now(),
        );

        // Handle errors
        if (res.error) {
          m.ack();
          this.seq = m.seq;
          continue;
        }

        this.execute(res);
        m.ack();
        this.seq = m.seq;
      } catch (e) {
        console.log(e);
        m.ack();
        this.seq = m.seq;
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

      // Get the last snapshot sequence from the kv store
      try {
        // First VACUUM the database to free up space
        this.db.exec("VACUUM");

        const e = await this.kv.get("snapshot");
        const lastSnapSeq = e ? Number(this.sc.decode(e.value)) : 0;
        console.log(`Last snapshot sequence: ${lastSnapSeq}`);

        // Check if we need to snapshot
        if (this.seq - lastSnapSeq < this.snapThreshold) {
          console.log(
            `Skipping snapshot, sequence number threshold not met: ${
              this.seq - lastSnapSeq
            } < ${this.snapThreshold}`,
          );
          continue;
        }

        // Unsubscribe from the stream so we stop receiving db updates
        this.sub.unsubscribe();
        console.log("Unsubscribed from stream");

        // Snapshot the database to object store
        if (!await snapshot(this.os, this.dbFile)) {
          console.log("Error during snapshot");
          this.sub = await this.js.subscribe(this.subject, this.opts);
          this.iterator(this.sub);
          continue;
        }

        // Update the kv store with the last snapshot sequence number
        await this.kv.put("snapshot", this.sc.encode(String(this.seq)));
        console.log(`Updated snapshot kv sequence to ${this.seq}`);

        // Purge messages from the stream older than this.seq + 1
        await this.jsm.streams.purge(this.app, {
          filter: this.subject,
          seq: this.seq + 1,
        });
      } catch (e) {
        console.log("Error during snapshot polling", e);
      }

      // Resubscribe to the stream
      console.log("Resubscribing to stream");
      this.sub = await this.js.subscribe(this.subject, this.opts);
      this.iterator(this.sub);
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
