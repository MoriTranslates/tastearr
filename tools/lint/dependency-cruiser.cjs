/**
 * Layer rules for the server (see ARCHITECTURE.md). Run from the repository root: `npm run depcheck`.
 * Dependencies point one way: http -> services -> (core, adapters, data); core depends on nothing but shared.
 */
const layer = (name) => `^server/${name}/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", comment: "Import cycles make load order and testing fragile.", from: {}, to: { circular: true } },
    { name: "not-to-unresolvable", severity: "error", from: {}, to: { couldNotResolve: true } },
    {
      name: "core-is-pure",
      severity: "error",
      comment: "core/ is plain logic over plain data: no database, network, file system or other layers. Only shared types.",
      from: { path: layer("core") },
      to: { pathNot: ["^server/core/", "^shared/", "^(node:)?(net|crypto)$"] },
    },
    {
      name: "adapters-only-talk-outward",
      severity: "error",
      comment: "An adapter wraps one external service. It must not reach into the database, services or HTTP routes.",
      from: { path: layer("adapters") },
      to: { path: ["^server/(services|http|data)/", "^server/index\.ts$"] },
    },
    {
      name: "data-is-a-leaf",
      severity: "error",
      comment: "The data layer is SQL only; it must not call services, adapters or routes.",
      from: { path: layer("data") },
      to: { path: ["^server/(services|http|adapters)/", "^server/index\.ts$"] },
    },
    {
      name: "services-not-to-http",
      severity: "error",
      from: { path: layer("services") },
      to: { path: ["^server/http/", "^server/index\.ts$"] },
    },
    {
      name: "http-goes-through-services",
      severity: "error",
      comment: "Routes validate, call a service and shape the response. Database and outside calls happen in services.",
      from: { path: layer("http") },
      to: { path: "^server/(adapters|data)/" },
    },
    {
      name: "shared-is-a-leaf",
      severity: "error",
      comment: "shared/ holds API types used by both server and web, so it imports nothing.",
      from: { path: "^shared/" },
      to: { pathNot: "^shared/" },
    },
    {
      name: "web-not-to-server",
      severity: "error",
      comment: "The browser bundle talks to the server over HTTP only; shared types are the contract.",
      from: { path: "^web/" },
      to: { path: "^server/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "test/tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
    },
  },
};
