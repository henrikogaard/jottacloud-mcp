import { createRoot } from "react-dom/client";
import { FileApp } from "./FileApp";
import { HostBridge } from "./bridge";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <FileApp bridge={new HostBridge()} />,
);
