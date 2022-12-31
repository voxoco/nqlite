FROM denoland/deno:alpine

RUN apk add --no-cache tzdata

EXPOSE 4001

WORKDIR /app

ADD . .

RUN deno cache main.ts

# Pre-download the sqlite module
RUN deno run -A --unstable build-lib.ts

ENTRYPOINT ["deno", "run", "-A", "--unstable", "main.ts"]