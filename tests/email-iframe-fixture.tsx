import React from "react";
import { createRoot } from "react-dom/client";
import EmailIframe from "../app/components/EmailIframe";

const body = `<style>.headline { color: rgb(12, 34, 56); }</style>
<table><tr><td class="headline">Email heading</td></tr></table>
<img alt="inline fixture" src="/fixture-inline.png">
<img alt="remote fixture" src="https://images.example.com/logo.png">
<a href="https://example.com/signin">Sign in</a>
<a href="javascript:alert(1)">Bad link</a>
<script>parent.postMessage({ bad: true }, '*')</script>`;
createRoot(document.getElementById("root")!).render(<EmailIframe body={body} autoSize />);
