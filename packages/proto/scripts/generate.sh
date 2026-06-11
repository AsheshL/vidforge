#!/usr/bin/env bash
# Generates TypeScript from .proto via ts-proto, targeting @grpc/grpc-js.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf gen
mkdir -p gen

PROTOC_GEN_TS_PROTO="$(pnpm bin)/protoc-gen-ts_proto"

npx grpc_tools_node_protoc \
  --plugin=protoc-gen-ts_proto="$PROTOC_GEN_TS_PROTO" \
  --ts_proto_out=gen \
  --ts_proto_opt=outputServices=grpc-js,env=node,esModuleInterop=true,useDate=true,outputIndex=true \
  --proto_path=src \
  src/*.proto

echo "Generated TypeScript into packages/proto/gen/"
