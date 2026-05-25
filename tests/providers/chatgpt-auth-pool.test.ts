import { describe, it, expect } from "vitest";
import { chatgptAuthMaterialCandidates, parseChatGPTAuthAccountsList } from "../../src/providers/chatgpt-auth-pool";

describe("chatgpt auth pool", () => {
  it("parses JSON array of auth blobs", () => {
    const list = parseChatGPTAuthAccountsList(JSON.stringify([
      JSON.stringify({ access_token: "a", account_id: "1", id_token: "i", refresh_token: "r" }),
    ]));
    expect(list.length).toBe(1);
    expect(list[0]).toContain("access_token");
  });

  it("parses JSON array of env key names", () => {
    const list = parseChatGPTAuthAccountsList(JSON.stringify(["CHATGPT_AUTH_ACCOUNT_1"]));
    expect(list).toEqual(["CHATGPT_AUTH_ACCOUNT_1"]);
  });

  it("rotates candidates by request id", () => {
    const env = {
      CHATGPT_AUTH_JSON: JSON.stringify({
        access_token: "primary",
        account_id: "p",
        id_token: "i",
        refresh_token: "r",
      }),
      CHATGPT_AUTH_ACCOUNTS: JSON.stringify([
        JSON.stringify({
          access_token: "secondary",
          account_id: "s",
          id_token: "i2",
          refresh_token: "r2",
        }),
      ]),
    };
    const a = chatgptAuthMaterialCandidates(env, undefined, "req-a")[0];
    const b = chatgptAuthMaterialCandidates(env, undefined, "req-b")[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toEqual(b);
  });
});
