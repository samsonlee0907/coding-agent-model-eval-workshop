const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BENCHMARK_FAKE_AZ_LOG, JSON.stringify(args) + "\n");
if (args[0] !== "account" || args[1] !== "get-access-token") {
  console.error("Fake az denies every command except account get-access-token.");
  process.exit(1);
}
if (args.includes("--subscription") && args.includes("--tenant")) {
  console.error("ERROR: Please specify only one of subscription and tenant, not both");
  console.error("private@example.invalid secret=FAKE_PRIVATE_STDERR");
  process.exit(1);
}
if (args[args.indexOf("--resource") + 1] !== "https://ai.azure.com") {
  console.error("Fake az denies unexpected token audiences.");
  process.exit(1);
}
console.log(JSON.stringify({ accessToken: "FAKE_AZ_SUBPROCESS_TOKEN", expires_on: 4070908800, tokenType: "Bearer" }));
