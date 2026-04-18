import { createGateway } from "./app";
import { gatewayEnv } from "./env";

const { server } = createGateway(gatewayEnv);

server.listen(gatewayEnv.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`gateway listening on ${gatewayEnv.PORT}`);
});
