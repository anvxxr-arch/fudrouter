// $env/* shim for `scripts/workers.mjs`: the worker reads its environment from
// process.env (the entrypoint runs under `node --env-file=.env`), so the
// legacy `$env/dynamic/private` view is just process.env.
export const env = process.env;
