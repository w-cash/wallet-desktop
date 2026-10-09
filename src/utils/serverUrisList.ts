import { ServerChainNameEnum, ServerClass } from "../components/appstate";

const serverUrisList = (): ServerClass[] => [
  {
    uri: "https://mainnet.zecwec.com:443",
    chain_name: ServerChainNameEnum.mainChainName,
    default: true,
    latency: null,
    obsolete: false,
  },
  {
    uri: "https://wallet-testnet.wcashexplorer.com:443",
    chain_name: ServerChainNameEnum.testChainName,
    default: true,
    latency: null,
    obsolete: false,
  },
  {
    uri: "http://127.0.0.1:48234",
    chain_name: ServerChainNameEnum.regtestChainName,
    default: true,
    latency: null,
    obsolete: false,
  },
];

export default serverUrisList;
