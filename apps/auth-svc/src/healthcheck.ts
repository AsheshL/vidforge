// Container health probe — see the HEALTHCHECK in this app's Dockerfile.
import { runHealthProbe } from "@vidforge/grpc-health";

await runHealthProbe(`127.0.0.1:${process.env.PORT ?? "50053"}`);
