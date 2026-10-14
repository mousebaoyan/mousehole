import { createContext as createReactContext } from "react";
import { createContext } from "react-router";

// The CSP nonce of a page (design §13), carried from the server's middleware through the load
// context to the scripts written inline. Without a CSP, as in local development, there is none.
export const nonceContext = createContext<string | undefined>(undefined);
export const Nonce = createReactContext<string | undefined>(undefined);
