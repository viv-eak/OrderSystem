import { createApp } from "./app";
import { authEnv } from "./env";

const app = createApp(authEnv);

app.listen(authEnv.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`auth-service listening on ${authEnv.PORT}`);
});
