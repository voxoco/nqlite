FROM denoland/deno:alpine

EXPOSE 4001

WORKDIR /app

COPY import_map.json .
RUN deno cache import_map.json

ADD . .

RUN deno cache main.ts

# Pre-download the sqlite module
RUN deno run -A --unstable build-lib.ts

ENTRYPOINT ["deno", "run", "-A", "--unstable", "main.ts"]