import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  buildLexicalPatterns,
  looksLikeContactData,
  RAG_MATCH_COUNT,
  RAG_MATCH_THRESHOLD,
} from "../api/chat.js";

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

function anthropicResponse(content) {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

test("rejects requests without a message", async () => {
  const res = mockResponse();
  await handler({ method: "POST", body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'Field "message" is required');
});

test("uses a Voyage-compatible RAG threshold and enough context", () => {
  assert.equal(RAG_MATCH_THRESHOLD, 0.25);
  assert.equal(RAG_MATCH_COUNT, 5);
});

test("does not treat clinic phone questions as contact data", () => {
  assert.equal(looksLikeContactData("Какой у вас телефон?"), false);
  assert.equal(looksLikeContactData("Телефон +37129999999"), true);
});

test("expands family doctor wording to therapist price synonyms", () => {
  const patterns = buildLexicalPatterns("Сколько стоит прием семейного врача?");
  assert.equal(patterns.includes("%терапевт%"), true);
});

test("continues an existing booking without reclassifying it", async () => {
  process.env.ANTHROPIC_API_KEY = "test";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return anthropicResponse(
      JSON.stringify({
        name: "Анна",
        phone: "+79991234567",
        service: "Терапевт",
        date: "",
      }),
    );
  };

  try {
    const res = mockResponse();
    await handler(
      {
        method: "POST",
        body: {
          message: "Телефон +79991234567",
          booking: {
            name: "Анна",
            phone: "",
            service: "Терапевт",
            date: "",
          },
        },
      },
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.status, "collecting");
    assert.equal(
      res.payload.reply,
      "Уточните, пожалуйста: желаемые дату или время.",
    );
    assert.deepEqual(res.payload.booking, {
      name: "Анна",
      phone: "+79991234567",
      service: "Терапевт",
      date: "",
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.anthropic\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps a service collected on the first booking turn", async () => {
  process.env.ANTHROPIC_API_KEY = "test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    anthropicResponse(
      JSON.stringify({
        name: "",
        phone: "",
        service: "консультация и пломба",
        date: "",
      }),
    );

  try {
    const res = mockResponse();
    await handler(
      {
        method: "POST",
        body: { message: "нужна консультация и пломба" },
      },
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.intent, "BOOKING");
    assert.equal(res.payload.status, "collecting");
    assert.deepEqual(res.payload.booking, {
      name: "",
      phone: "",
      service: "консультация и пломба",
      date: "",
    });
    assert.equal(
      res.payload.reply,
      "Уточните, пожалуйста: имя, телефон, желаемые дату или время.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("posts a complete lead when Claude returns strict JSON", async () => {
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.MAKE_WEBHOOK_URL = "https://hook.example.test/clinic";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    if (String(url) === process.env.MAKE_WEBHOOK_URL) {
      return new Response("Accepted", { status: 200 });
    }
    return anthropicResponse(
      JSON.stringify({
        name: "Анна",
        phone: "+79991234567",
        service: "Терапевт",
        date: "завтра в 15:00",
      }),
    );
  };

  try {
    const res = mockResponse();
    await handler(
      {
        method: "POST",
        body: {
          message: "Завтра в 15:00",
          booking: {
            name: "Анна",
            phone: "+79991234567",
            service: "Терапевт",
            date: "",
          },
        },
      },
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.status, "submitted");
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[1].body), {
      name: "Анна",
      phone: "+79991234567",
      service: "Терапевт",
      date: "завтра в 15:00",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routes contact details to booking even when message mentions price", async () => {
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.MAKE_WEBHOOK_URL = "https://hook.example.test/clinic";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    if (String(url) === process.env.MAKE_WEBHOOK_URL) {
      return new Response("Accepted", { status: 200 });
    }
    return anthropicResponse(`Спасибо, данные собраны.

\`\`\`json
{
  "name": "Егор",
  "phone": "3275555",
  "service": "гастроэнтеролог",
  "date": "на завтра"
}
\`\`\``);
  };

  try {
    const res = mockResponse();
    await handler(
      {
        method: "POST",
        body: {
          message: "Егор,3275555, гастроэнтеролог, стоимость, на завтра",
        },
      },
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.intent, "BOOKING");
    assert.equal(res.payload.status, "submitted");
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /api\.anthropic\.com/);
    assert.equal(calls[0].body.includes("Верни только одно слово"), false);
    assert.deepEqual(JSON.parse(calls[1].body), {
      name: "Егор",
      phone: "3275555",
      service: "гастроэнтеролог",
      date: "на завтра",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
