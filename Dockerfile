# Runs the spacedata MCP server over stdio. Used by MCP hosts and
# registries (e.g. Glama) that run servers in containers for inspection.
FROM node:22-alpine

RUN npm install -g spacedata

ENTRYPOINT ["spacedata", "serve"]
