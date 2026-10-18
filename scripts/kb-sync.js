// Uploads the hotel knowledge base (kb/*.txt) to a Telnyx Storage bucket and
// embeds it for the assistant's retrieval tool:   npm run kb:sync
// Re-run it after editing kb/: only changed files are uploaded. The bucket is
// KB_BUCKET (set by npm run setup; else the one in assistant/assistant.json) in
// KB_REGION (default us-central-1).
import { assistantConfig, syncKnowledgeBase } from "./lib/telnyx.js";

try { process.loadEnvFile(); } catch { /* use the real environment */ }
const { TELNYX_API_KEY: key, KB_REGION: region = "us-central-1" } = process.env;
const bucket = process.env.KB_BUCKET || assistantConfig().tools.find((t) => t.type === "retrieval").retrieval.bucket_ids[0];
if (!key) {
  console.error("TELNYX_API_KEY is not set (run npm run setup first).");
  process.exit(1);
}
try {
  await syncKnowledgeBase({ key, bucket, region });
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
