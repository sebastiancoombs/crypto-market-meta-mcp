// Cloudflare Workers entry point.
import { app } from "./app.js";

export default {
  fetch: app.fetch,
};
