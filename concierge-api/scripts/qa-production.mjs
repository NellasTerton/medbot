import { existsSync, readFileSync } from "node:fs";

const API_URL =
  process.env.API_URL || "https://concierge-api-eight.vercel.app/api/chat";
const USE_LOCAL_HANDLER = process.env.LOCAL_HANDLER === "1";

const runId = `qa-${Date.now()}`;

export const tests = [
  {
    name: "short phone wording",
    message: "Телефон клиники?",
    expect: { intent: "QUESTION", includesAny: ["+371", "67"] },
  },
  {
    name: "email wording",
    message: "Куда можно написать на email?",
    expect: { intent: "QUESTION", includesAny: ["info@alma.lv", "alma.lv"] },
  },
  {
    name: "Saturday wording",
    message: "Вы работаете в субботу?",
    expect: { intent: "QUESTION", includesAny: ["суббот", "9", "15"] },
  },
  {
    name: "generic GP price",
    message: "Цена консультации семейного врача?",
    expect: { intent: "QUESTION", includesAny: ["35", "55", "евро", "eur"] },
  },
  {
    name: "general practice price",
    message: "Сколько стоит визит к врачу общей практики?",
    expect: { intent: "QUESTION", includesAny: ["35", "55", "евро", "eur"] },
  },
  {
    name: "latvian family doctor price",
    message: "Cik maksā ģimenes ārsta vizīte?",
    expect: { intent: "QUESTION", includesAny: ["35", "55", "eur"] },
  },
  {
    name: "endocrinologist availability",
    message: "Эндокринолог есть?",
    expect: { intent: "QUESTION", includesAny: ["эндокринолог"] },
  },
  {
    name: "neurologist doctor name",
    message: "Как зовут невролога?",
    expect: { intent: "QUESTION", includesAny: ["невролог", "айнар", "vecvagars"] },
  },
  {
    name: "thyroid ultrasound doctor",
    message: "Кто делает УЗИ щитовидной железы?",
    expect: { intent: "QUESTION", includesAny: ["астра", "сергеев", "узи"] },
  },
  {
    name: "thyroid ultrasound price",
    message: "Сколько стоит УЗИ щитовидной железы?",
    expect: { intent: "QUESTION", includesAny: ["60", "евро", "eur"] },
  },
  {
    name: "back massage price",
    message: "Цена полного массажа спины?",
    expect: { intent: "QUESTION", includesAny: ["45", "евро", "eur"] },
  },
  {
    name: "podologist consultation price",
    message: "Сколько стоит консультация подолога?",
    expect: { intent: "QUESTION", includesAny: ["45", "евро", "eur"] },
  },
  {
    name: "pregnancy care",
    message: "Ведете беременность?",
    expect: { intent: "QUESTION", includesAny: ["беремен", "гинеколог"] },
  },
  {
    name: "holter monitoring",
    message: "Можно пройти холтер сердца?",
    expect: { intent: "QUESTION", includesAny: ["холтер", "монитор"] },
  },
  {
    name: "blood pressure monitoring",
    message: "Есть суточное мониторирование давления?",
    expect: { intent: "QUESTION", includesAny: ["давлен", "монитор"] },
  },
  {
    name: "children dental hygiene",
    message: "Делаете гигиену зубов детям?",
    expect: { intent: "QUESTION", includesAny: ["гигиен", "дет"] },
  },
  {
    name: "certificate wording",
    message: "Можно получить справку для работы?",
    expect: { intent: "QUESTION", includesAny: ["справ", "работ"] },
  },
  {
    name: "privacy question",
    message: "Как вы храните мои персональные данные?",
    expect: { intent: "QUESTION", includesAny: ["персональ", "данн"] },
  },
  {
    name: "booking start neurologist",
    message: "Запишите меня к неврологу",
    session: "booking-neurologist",
    expect: { intent: "BOOKING", status: "collecting", bookingService: "невролог" },
  },
  {
    name: "question during neurologist booking",
    message: "А сколько стоит прием?",
    session: "booking-neurologist",
    expect: { intent: "QUESTION", includesAny: ["35", "55", "евро", "eur"] },
  },
  {
    name: "booking adds contact only",
    message: "Мария, +37129912345",
    session: "booking-neurologist",
    expect: {
      intent: "BOOKING",
      status: "collecting",
      bookingName: "мария",
      bookingPhone: "29912345",
      bookingService: "невролог",
    },
  },
  {
    name: "booking cancel plain",
    message: "Отменить запись",
    session: "booking-neurologist",
    expect: { intent: "BOOKING", status: "cancelled", includesAny: ["отмен"] },
  },
  {
    name: "booking start ultrasound",
    message: "Хочу на УЗИ щитовидки",
    session: "booking-usg",
    expect: { intent: "BOOKING", status: "collecting", bookingService: "узи" },
  },
  {
    name: "booking info question keeps draft",
    message: "Какой у вас адрес?",
    session: "booking-usg",
    expect: { intent: "QUESTION", includesAny: ["адрес", "улиц", "stabu", "рига"] },
  },
  {
    name: "booking cancel colloquial",
    message: "Я передумала",
    session: "booking-usg",
    expect: { intent: "BOOKING", status: "cancelled", includesAny: ["отмен"] },
  },
];

if (USE_LOCAL_HANDLER) {
  loadEnvFile(new URL("../.env.local", import.meta.url));
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadEnvFile(fileUrl) {
  if (!existsSync(fileUrl)) {
    return;
  }

  const text = readFileSync(fileUrl, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const [name, ...valueParts] = trimmed.split("=");
    if (!process.env[name]) {
      process.env[name] = valueParts.join("=").trim();
    }
  }
}

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

let localHandlerPromise;

async function postLocalMessage(test) {
  localHandlerPromise ||= import("../api/chat.js").then((mod) => mod.default);
  const handler = await localHandlerPromise;
  const res = mockResponse();
  await handler(
    {
      method: "POST",
      headers: {
        "x-concierge-session-id": `${runId}-${test.session || test.name}`,
        "user-agent": "qa-local",
      },
      socket: { remoteAddress: "127.0.0.1" },
      body: { message: test.message },
    },
    res,
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}: ${JSON.stringify(res.payload)}`);
  }
  return res.payload;
}

async function postMessage(test) {
  if (USE_LOCAL_HANDLER) {
    return postLocalMessage(test);
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Concierge-Session-Id": `${runId}-${test.session || test.name}`,
    },
    body: JSON.stringify({ message: test.message }),
  });
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Non-JSON response: ${body.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function verify(test, data) {
  const expected = test.expect;
  assertCondition(data.intent === expected.intent, `intent ${data.intent}`);

  if (expected.status) {
    assertCondition(data.status === expected.status, `status ${data.status}`);
  }

  const reply = normalize(data.reply);
  if (expected.includesAny) {
    assertCondition(
      expected.includesAny.some((token) => reply.includes(token)),
      `reply does not include any of: ${expected.includesAny.join(", ")}`,
    );
  }

  if (expected.intent === "QUESTION") {
    assertCondition(reply.length > 20, "question reply is too short");
    assertCondition(!reply.includes("**"), "reply contains Markdown markers");
  }

  const booking = data.booking || {};
  if (expected.bookingName) {
    assertCondition(
      normalize(booking.name).includes(expected.bookingName),
      `booking.name ${booking.name}`,
    );
  }
  if (expected.bookingPhone) {
    assertCondition(
      normalize(booking.phone).includes(expected.bookingPhone),
      `booking.phone ${booking.phone}`,
    );
  }
  if (expected.bookingService) {
    assertCondition(
      normalize(booking.service).includes(expected.bookingService),
      `booking.service ${booking.service}`,
    );
  }
}

let passed = 0;

console.log(
  USE_LOCAL_HANDLER
    ? "Running QA tests against local handler"
    : `Running QA tests against ${API_URL}`,
);

for (const [index, test] of tests.entries()) {
  let data;
  try {
    data = await postMessage(test);
    verify(test, data);
    passed += 1;
    console.log(`ok ${index + 1} - ${test.name}`);
  } catch (error) {
    error.data ||= data;
    console.error(`not ok ${index + 1} - ${test.name}`);
    console.error(`  message: ${test.message}`);
    console.error(`  error: ${error.message}`);
    if (error.data) {
      console.error(`  response: ${JSON.stringify(error.data)}`);
    }
    process.exitCode = 1;
  }
}

console.log(`${passed}/${tests.length} QA tests passed`);
