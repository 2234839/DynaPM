# DynaPM

[中文文档](./README_zh.md)

This is a program management tool for dynamically starting and stopping programs, with some serverless-like features. The goal is to maintain a large number of low-frequency accessed programs while keeping a few high-frequency accessed programs running online, all while dealing with limited resources in a private deployment environment.

Each time a user accesses one of these programs, if the program is offline, the gateway temporarily suspends the request and immediately starts the program. Once the program starts successfully, the gateway acts as a reverse proxy.

When memory is insufficient or a program has been idle for a long time, the program is automatically shut down to free up server resources.

Starting the simplest Node.js HTTP program using pm2 takes approximately 600ms.

```log
Starting [test]
Starting [test] took 601 ms
Stopping [test]
Starting [test]
Starting [test] took 592 ms
Stopping [test]
```

## Introduction

I often want to write programs that run continuously, and I hope to be able to access their websites or call their APIs at any time. However, these programs are not always working, so I also hope that when they are not working, they consume almost no CPU or RAM except for disk space. Previously, I looked into serverless solutions, but they were still quite麻烦 in terms of deployment and did not fully utilize my idle servers.

Now I can use DynaPM to keep thousands of programs ready for immediate access as long as my disk space allows. Of course, the actual number of programs that can run simultaneously may be limited to dozens depending on the machine's capacity, but most of the programs I have written in the past do not have long service times, so this limitation should not be a problem.

## Features

- [x] Start programs using pm2 when a request arrives
- [x] Shut down programs when they are idle
- [ ] Support auto-scaling
- [ ] Support persistent operation (only shut down programs when idle RAM is insufficient)
- [ ] Support cron jobs
- [ ] Support dynamically starting and stopping Docker containers
- [ ] Support starting programs using spawn/fork

## Performance

### fastify + @fastify/reply-from

After a cold start, testing performance with `autocannon http://127.0.0.1:83` yields an average of 3000 req/s.