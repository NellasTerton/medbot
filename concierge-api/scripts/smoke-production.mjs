const API_URL =
  process.env.API_URL || "https://concierge-api-eight.vercel.app/api/chat";

const runId = `smoke-${Date.now()}`;

const tests = [
  {
    name: "clinic address",
    message: "Где находится клиника?",
    expect: { intent: "QUESTION", includesAny: ["адрес", "улиц", "stabu", "рига"] },
  },
  {
    name: "phone number",
    message: "Какой у вас телефон?",
    expect: { intent: "QUESTION", includesAny: ["+371", "67"] },
  },
  {
    name: "working hours",
    message: "Какой график работы клиники?",
    expect: { intent: "QUESTION", includesAny: ["понедельник", "суббот", "работ"] },
  },
  {
    name: "doctors list",
    message: "Какие врачи у вас принимают?",
    expect: { intent: "QUESTION", includesAny: ["гинеколог", "семейн", "врач"] },
  },
  {
    name: "gynecologist price",
    message: "Сколько стоит прием гинеколога?",
    expect: { intent: "QUESTION", includesAny: ["35", "55", "евро", "eur"] },
  },
  {
    name: "therapist price",
    message: "Сколько стоит прием терапевта?",
    expect: { intent: "QUESTION", includesAny: ["35", "55", "евро", "eur"] },
  },
  {
    name: "x-ray availability",
    message: "Есть ли у вас рентген?",
    expect: { intent: "QUESTION", includesAny: ["рентген", "снимок", "12"] },
  },
  {
    name: "dental treatment",
    message: "Лечите ли вы зубы?",
    expect: { intent: "QUESTION", includesAny: ["зуб", "гигиен", "лечение"] },
  },
  {
    name: "vaccination",
    message: "Делаете ли вы вакцинацию детям?",
    expect: { intent: "QUESTION", includesAny: ["вакцин", "дет"] },
  },
  {
    name: "ultrasound",
    message: "Можно сделать УЗИ?",
    expect: { intent: "QUESTION", includesAny: ["узи", "ультра", "usg"] },
  },
  {
    name: "neurologist",
    message: "Есть ли невролог?",
    expect: { intent: "QUESTION", includesAny: ["невролог"] },
  },
  {
    name: "pediatrician",
    message: "Принимает ли педиатр?",
    expect: { intent: "QUESTION", includesAny: ["педиатр", "ребен"] },
  },
  {
    name: "massage",
    message: "Какие массажи есть в клинике?",
    expect: { intent: "QUESTION", includesAny: ["массаж"] },
  },
  {
    name: "podologist",
    message: "Есть ли подолог?",
    expect: { intent: "QUESTION", includesAny: ["подолог", "педикюр", "стоп"] },
  },
  {
    name: "price wording with appointment",
    message: "Сколько стоит прием семейного врача?",
    expect: { intent: "QUESTION", includesAny: ["35", "55", "евро", "eur"] },
  },
  {
    name: "booking start gynecologist",
    message: "Хочу записаться к гинекологу",
    session: "booking-gynecology",
    expect: { intent: "BOOKING", status: "collecting", bookingService: "гинек" },
  },
  {
    name: "question during booking remains question",
    message: "А сколько стоит прием гинеколога?",
    session: "booking-gynecology",
    expect: { intent: "QUESTION", includesAny: ["35", "55", "евро", "eur"] },
  },
  {
    name: "booking keeps service",
    message: "Егор, +37129999999",
    session: "booking-gynecology",
    expect: {
      intent: "BOOKING",
      status: "collecting",
      bookingName: "егор",
      bookingPhone: "29999999",
      bookingService: "гинек",
    },
  },
  {
    name: "booking cancellation",
    message: "Отмена, я передумал",
    session: "booking-gynecology",
    expect: { intent: "BOOKING", status: "cancelled", includesAny: ["отмен"] },
  },
  {
    name: "booking start vaccination",
    message: "Хочу записать ребенка на вакцинацию",
    session: "booking-vaccine",
    expect: { intent: "BOOKING", status: "collecting", bookingService: "вакцин" },
  },
];

function normalize(value) {
  return String(value || "").toLowerCase();
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function postMessage(test) {
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

for (const [index, test] of tests.entries()) {
  try {
    const data = await postMessage(test);
    verify(test, data);
    passed += 1;
    console.log(`ok ${index + 1} - ${test.name}`);
  } catch (error) {
    console.error(`not ok ${index + 1} - ${test.name}`);
    console.error(`  message: ${test.message}`);
    console.error(`  error: ${error.message}`);
    process.exitCode = 1;
    break;
  }
}

console.log(`${passed}/${tests.length} smoke tests passed`);
