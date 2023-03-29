# nqlite (NATS)qlite

nqlite is an easy-to-use, lightweight relational database using
[SQLite](https://www.sqlite.org/) as the storage engine and
[NATS Jetstream](https://docs.nats.io/nats-concepts/jetstream) for replication
and persistence. nqlite is heavily influenced by
[rqlite](https://github.com/rqlite/rqlite) but provides a simpler data API
because there is no need for a RAFT leader.

nqlite aims to solve the problems of distributing relational data globally and
at the edge like:

- Management of IP's and DNS
- Complexity of read/write splitting and proxies
- Not having your relational data next to your application
- Disaster recovery/failover of master and general orchestration
- Traditional relational databases are not designed for edge deployments

## Features

- Simple HTTP API for interacting with SQLite via `db/query`
- Snapshotting/restore out of the box (using
  [Object Store](https://docs.nats.io/using-nats/developer/develop_jetstream/object))
- NATS JetStream for SQL replication and persistence (via
  [Ephemeral Push Consumer](https://docs.nats.io/using-nats/developer/develop_jetstream/consumers))
- Lightweight, easy-to-use - just run the binary and pass in the NATS Websocket
  URL
- Deploy anywhere - Linux, macOS, Windows, ARM, Edge, Kubernetes, Docker, etc.

## Why nqlite?

We love rqlite and NATS and think these two projects should marry, have a baby
and name it **nqlite**. We want to be able to deploy relational databases on the
edge at VOXO and not deal with the complexity of IP's, DNS, proxies,
survivability, orchestration, and consensus. nqlite has no concept of leader
election or primary/replica. NATS Jetstream serves as this durable layer with
its message sequencing and at-least-once delivery symantics. nqlite takes the
complexity out of **deploying globally distributed relational databases.**. All
it needs is a connection to NATS.

- NATS JetStream with at-least once delivery is a great fit for SQL replication
  and persistence
- Object Store is a great fit for snapshotting/restore
- Who doesn't already use NATS for pub/sub?
- The need for a dead simple edge relational database closer to the application
- **Database nodes don't need to be aware of each other**
- Deno is fun

## Quick Start

The quickest way to get up and running is to download the binary from the
[Releases](https://github.com/voxoco/nqlite/releases) page and run it like so:

```bash
$ nqlite --nats-host=wss://FQDN --creds=./nats.creds
```

### Command line options

```bash
nqlite [options]
    --nats-host=wss://... # NATS NATS host e.g 'nats://localhost:4222' || 'ws://localhost:8080' (required)
  
    --creds=./nats.creds # NATS creds file - required if --token not provided
  
    --token=secret # NATS auth token - required if --creds not provided

    --data-dir=/nqlite-data # Data directory - optional (default: ./nqlite-data)

    --external-backup=http # External backup/restore method (option: 'http')

    --external-backup-url=http://someBlockStorage/backup/nqlite.db # External backup/restore URL
  
    --h - Help
```

### Docker

```bash
docker run voxo/nqlite -p 4001:4001 --nats-host=wss://FQDN --creds=./nats.creds
```

The Docker image is available on
[Docker Hub](https://hub.docker.com/r/voxo/nqlite).

### Homebrew

```bash
$ brew install voxoco/apps/nqlite
$ nqlite --nats-host=wss://FQDN --token=secret
```

### Deno

```bash
$ deno run -A --unstable https://deno.land/x/nqlite/main.ts --nats-host=wss://FQDN --creds=./nats.creds
```

## Dependencies

- [natsws](https://deno.land/x/natsws/src/mod.ts) - For NATS
- [sqlite3](https://deno.land/x/sqlite) - For performance
- [Hono](https://deno.land/x/hono) - For HTTP API

## Coming Soon

- [ ] Prometheus exporter
- [ ] Transactions
- [ ] API Authentication
- [ ] InsertId and affectedRows in response
- [ ] Work with Deno Deploy (memory db)
- [ ] Handle queries via NATS request/reply
- [ ] Ideas welcome!

## How it works

nqlite is a Deno application that connects to NATS JetStream. It bootstraps
itself by creating the necessary JetStream streams, consumers, and object store.
It also takes care of snapshotting and restoring the SQLite db. When a node
starts up, it checks the object store for an SQLite snapshot. If it finds one,
it restores from the snapshot. If not, it creates a new SQLite db. The node then
subscribes to the JetStream stream at the last sequence number processed by the
SQLite db. Anytime the node receives a query via the stream, it executes the
query and updates the `_nqlite_` table with the sequence number. Read requests
are handled locally. Read more below about snapshotting and purging.

### Built-in configuration

```bash
# Default Data directory
./.nqlite-data/nqlite

# SQLite file
./.nqlite-data/nqlite/nqlite.db

# NATS JetStream stream
nqlite

# NATS JetStream publish subject
nqlite.push

# NATS object store bucket
nqlite

# Snapshot interval hours (check how often to snapshot the db)
2

# Snapshot threshold
# Every snapshot interval, check if we have processed
# this many messages since the last snapshot. If so, snapshot.
1024
```

### Snapshot and purging

Every `snapInterval` nqlite gets the latest snapshot sequence from object store
description and compares it with the last processed sequence number from
JetStream. If the node has processed more than `snapThreshold` messages since
the object store snapshot sequence, the node unsubscribes from the stream and
attempts a snapshot.

The node backs up the SQLite db to object store and sets the latest processed
sequence number to the object store `description` and purges all previous
messages from the stream (older than `snapSequence - snapThreshold`). The node
then resumes the JetStream subscription. The nice thing here is that JetStream
will continue pushing messages to the interator from where it left off (so the
node doesn’t miss any db changes and eventually catches back up).

The other nice thing about this setup is that we can still accept writes on this
node while the snapshotting is taking place. So the only sacrifice we make here
is the nodes are eventually consistent (which seems to be an acceptable trade
off).

### Snapshot restore

When a node starts up, it checks if there is a snapshot in object store. If
there is, it attempts to restore the SQLite db from object store. If there is no
snapshot, it creates a new SQLite db and subscribes to the stream.

### API

nqlite has a simple HTTP API for interacting with SQLite. Any db changes like
(`INSERT`, `UPDATE`, `DELETE`) are published to a NATS JetStream subject. NATS
handles replicating to other nqlite nodes. Any db queries like (`SELECT`) are
handled locally and do not get published to NATS.

## Data API

### `db/query`

Each nqlite node exposes an HTTP API for interacting with SQLite. Any db changes
like (`INSERT`, `UPDATE`, `DELETE`) are published to NATS JetStream via an
`nqlite.push` subject and replicated to other nqlite nodes. Any db queries like
(`SELECT`) are handled locally and do not require NATS. All data requests are
handled via a `POST` or `GET` request to the `/db/query` endpoint.

### Writing Data

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  "CREATE TABLE foo (id INTEGER NOT NULL PRIMARY KEY, name TEXT, age INTEGER)"
]'

curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  "INSERT INTO foo(name, age) VALUES(\"fiona\", 20)"
]'
```

### Response

```json
{
  "results": [
    {
      "nats": {
        "stream": "nqlite",
        "seq": 4,
        "duplicate": false
      }
    }
  ],
  "time": 18.93841699999757 // ms to publish to NATS
}
```

### Querying Data

```bash
curl -G 'localhost:4001/db/query' --data-urlencode 'q=SELECT * FROM foo'
```

#### OR

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  "SELECT * FROM foo"
]'
```

### Response

```json
{
  "results": [
    {
      "rows": [
        {
          "id": 1,
          "name": "fiona",
          "age": 20
        }
      ]
    }
  ],
  "time": 0.5015830000047572 // ms to get results
}
```

## Parameterized Queries

### Write

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  ["INSERT INTO foo(name, age) VALUES(?, ?)", "fiona", 20]
]'
```

### Read

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  ["SELECT * FROM foo WHERE name=?", "fiona"]
]'
```

## Named Parameters

### Write

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  ["INSERT INTO foo(name, age) VALUES(:name, :age)", {"name": "fiona", "age": 20}]
]'
```

### Read

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  ["SELECT * FROM foo WHERE name=:name", {"name": "fiona"}]
]'
```

## Bulk Queries

### Write

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d "[
  \"INSERT INTO foo(name) VALUES('fiona')\",
  \"INSERT INTO foo(name) VALUES('sinead')\"
]"
```

### Parameterized Bulk Queries

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  ["INSERT INTO foo(name) VALUES(?)", "fiona"],
  ["INSERT INTO foo(name) VALUES(?)", "sinead"]
]'
```

## Named Parameter Bulk Queries

```bash
curl -XPOST 'localhost:4001/db/query' -H "Content-Type: application/json" -d '[
  ["INSERT INTO foo(name) VALUES(:name)", {"name": "fiona"}],
  ["INSERT INTO foo(name) VALUES(:name)", {"name": "sinead"}]
]'
```

## Transactions

Not implemented yet

## Error handling

nqlite will return a body that looks like this:

```json
{
  "results": [
    {
      "error": "Some error message"
    }
  ],
  "time": 0.5015830000047572
}
```

## Contributing

Contributions are welcome! Please open an issue or PR. Any criticism/ideas are
welcome.
