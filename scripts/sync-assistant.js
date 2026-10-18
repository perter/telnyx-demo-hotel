// Create or update the Telnyx AI Assistant from assistant/assistant.json and
// assistant/instructions.md (first run: use `npm run setup`, which also does this).
//   npm run assistant:sync            push the repo config
//   npm run assistant:sync -- --pull  copy the live prompt and model into the repo
//   npm run assistant:sync -- --force push even if the live assistant was edited
// With TELNYX_ASSISTANT_ID set it updates that assistant (the voice is left alone:
// the backend sets it per call); otherwise it creates one. Admins can edit the live
// assistant from /assistant.html, so a push refuses to overwrite a live prompt or
// model that differs from the repo unless --force.
import { assistantConfig, liveDifferences, pullAssistant, readAssistant, saveAssistant } from "./lib/telnyx.js";

try { process.loadEnvFile(); } catch { /* use the real environment */ }
const { TELNYX_API_KEY: key, TELNYX_ASSISTANT_ID: id, KB_BUCKET: bucket } = process.env;
if (!key) {
  console.error("TELNYX_API_KEY is not set (run npm run setup first).");
  process.exit(1);
}

try {
  const config = assistantConfig({ bucket, keepVoice: !!id });
  if (id) {
    const live = await readAssistant(key, id);
    if (process.argv.includes("--pull")) {
      pullAssistant(live);
      console.log(`Pulled the prompt and model (${live.model}) from version ${live.version_id} into the repo.`);
      process.exit(0);
    }
    const differs = liveDifferences(live, config);
    if (differs.length && !process.argv.includes("--force")) {
      console.error(`The live assistant differs from the repo: ${differs.join(", ")}.`);
      console.error("It may have been edited from the admin panel. Run with -- --pull to keep the live version,");
      console.error("or -- --force to overwrite it with the repo (this also resets the listening and tool settings).");
      process.exit(1);
    }
  }
  const saved = await saveAssistant(key, id, config);
  console.log(`${id ? "Updated" : "Created"} ${saved.id}: "${saved.name}" (version ${saved.version_id})`);
  if (!id) console.log(`Add to .env:  TELNYX_ASSISTANT_ID=${saved.id}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
