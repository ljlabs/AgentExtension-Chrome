import { normalizeAndValidate } from "./validator.js";
const TARGET_PROPERTIES = {
  ref: {
    type: "string",
    description: "Element ref from get_interactive_snapshot, e.g. \"e12\". PREFERRED — provide this."
  },
  selector: {
    type: "string",
    description: "CSS selector. Use only if you do not have a ref."
  },
  xpath: {
    type: "string",
    description: "XPath expression. Use only if you have neither a ref nor a selector."
  }
};

// NOTE: intentionally no JSON-Schema `anyOf` for "one of ref/selector/xpath".
// Top-level anyOf/oneOf breaks grammar-constrained decoding in many local
// runtimes (llama.cpp, vLLM, Ollama), producing malformed action tool calls.
// The requirement is stated in each tool description, and the content script
// returns a clear, self-correcting error if no target is supplied.

export const AGENT_TOOLS = [
  {
    name: "get_page_info",
    description: "Get metadata about the bound page: URL, title, ready state, viewport, meta description, and current selection.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "get_html",
    description: "Get HTML from the bound page. By default scripts and styles are removed. Use selector/ref/xpath to target a subtree. Use maxLength to control size.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        maxLength: {
          type: "integer",
          minimum: 1,
          maximum: 1000000,
          default: 120000
        },
        includeScripts: {
          type: "boolean",
          default: false
        },
        includeStyles: {
          type: "boolean",
          default: false
        },
        includeComments: {
          type: "boolean",
          default: false
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_text",
    description: "Get visible text from the bound page or a targeted element.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        maxLength: {
          type: "integer",
          minimum: 1,
          maximum: 1000000,
          default: 50000
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_interactive_snapshot",
    description: "List interactive elements on the page and assign refs. Use these refs with click, type_text, set_value, press_key, and scroll_to.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector to narrow the snapshot."
        },
        maxElements: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 200
        },
        includeHidden: {
          type: "boolean",
          default: false
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_changes_since_last_interactive_snapshot",
    description: "Return a Git-style diff of interactive UI changes since the last snapshot or change check. If the URL changed or no baseline exists, returns a full interactive snapshot instead.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "click",
    description: "Click an element in the bound tab. Provide a target: \"ref\" from get_interactive_snapshot (preferred), or a \"selector\", or \"xpath\".",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        waitAfterMs: {
          type: "integer",
          minimum: 0,
          maximum: 15000,
          default: 350
        },
        force: {
          type: "boolean",
          default: false,
          description: "Click even if the element appears disabled."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "type_text",
    description: "Type text into an input, textarea, or contenteditable element. Provide the \"text\" plus a target: \"ref\" (preferred), \"selector\", or \"xpath\".",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        text: {
          type: "string"
        },
        clear: {
          type: "boolean",
          default: false,
          description: "Clear existing value before typing."
        },
        pressEnter: {
          type: "boolean",
          default: false
        },
        force: {
          type: "boolean",
          default: false
        }
      },
      required: ["text"],
      additionalProperties: false
    }
  },
  {
    name: "set_value",
    description: "Set the value of an input, textarea, select, checkbox, or radio. Provide the \"value\" plus a target: \"ref\" (preferred), \"selector\", or \"xpath\".",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        value: {
          type: ["string", "number", "boolean"],
          description: "Value to set. For checkbox/radio, true/false-like values are interpreted as checked state."
        }
      },
      required: ["value"],
      additionalProperties: false
    }
  },
  {
    name: "press_key",
    description: "Press a keyboard key on the active element or a targeted element. Examples: Enter, Tab, Escape, ArrowDown, a, b, c.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        key: {
          type: "string"
        }
      },
      required: ["key"],
      additionalProperties: false
    }
  },
  {
    name: "scroll_to",
    description: "Scroll to an element, or scroll the window to x/y coordinates.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        x: {
          type: "integer",
          minimum: 0
        },
        y: {
          type: "integer",
          minimum: 0
        },
        behavior: {
          type: "string",
          enum: ["auto", "smooth"],
          default: "auto"
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "wait",
    description: "Wait for a number of milliseconds before continuing.",
    parameters: {
      type: "object",
      properties: {
        ms: {
          type: "integer",
          minimum: 1,
          maximum: 30000
        }
      },
      required: ["ms"],
      additionalProperties: false
    }
  },
  {
    name: "http_request",
    description: "Make a raw HTTP request only when the user explicitly asks for an external API, raw HTTP operation, or resource that is not the bound page. Do not use this to read or operate the bound page; use browser tools for that. Only http/https allowed. Network permission may be requested.",
    requiresNetworkPermission: true,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string"
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
          default: "GET"
        },
        headers: {
          type: "object",
          additionalProperties: {
            type: "string"
          }
        },
        body: {
          type: ["string", "object", "array", "number", "boolean", "null"]
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          default: 30000
        },
        parseJson: {
          type: "boolean",
          default: true
        },
        maxChars: {
          type: "integer",
          minimum: 1000,
          maximum: 2000000,
          default: 200000
        },
        credentials: {
          type: "string",
          enum: ["omit", "same-origin", "include"],
          default: "omit"
        },
        redirect: {
          type: "string",
          enum: ["follow", "error", "manual"],
          default: "follow"
        }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "screenshot",
    description: "Capture a screenshot of the bound tab. Requires explicit user permission before image data is sent to the LLM.",
    requiresImagePermission: true,
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["jpeg", "png", "webp"],
          default: "jpeg"
        },
        quality: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 70
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_images",
    description: "List images on the page. If includeBase64 is true, image pixels are fetched and require explicit user permission.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          default: "img"
        },
        maxImages: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20
        },
        includeBase64: {
          type: "boolean",
          default: false
        },
        maxImageBytes: {
          type: "integer",
          minimum: 10000,
          maximum: 10000000,
          default: 1500000
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "read_browser_storage",
    description: "Read keys from the extension's browser storage. Use this to retrieve notes, configuration, or any data the agent has previously stored.",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Array of storage keys to read. If empty, returns all keys."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "write_browser_storage",
    description: "Write key-value pairs to the extension's browser storage. Use this to leave notes for yourself or persist state across conversations.",
    parameters: {
      type: "object",
      properties: {
        data: {
          type: "object",
          description: "Key-value pairs to store. Values can be strings, numbers, booleans, arrays, or objects.",
          additionalProperties: true
        }
      },
      required: ["data"],
      additionalProperties: false
    }
  },
  {
    name: "memories",
    description: "Manage agent memories — persistent markdown notes stored in browser storage. Use list/read/write/delete to maintain context across sessions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "write", "delete"],
          description: "Action to perform."
        },
        id: {
          type: "string",
          description: "Memory ID. Required for read and delete. For write, if omitted a new memory is created; if provided, the existing memory is updated."
        },
        title: {
          type: "string",
          description: "Title of the memory (used when writing)."
        },
        content: {
          type: "string",
          description: "Markdown content of the memory (used when writing)."
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "skills",
    description: "Manage agent skills — reusable knowledge articles stored with YAML front matter (name, description, tags) followed by a markdown body. List returns only metadata. Read returns full content. Write creates or updates a skill.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "write", "delete"],
          description: "Action to perform."
        },
        id: {
          type: "string",
          description: "Skill ID. Required for read and delete. For write, if omitted a new skill is created; if provided, the existing skill is updated."
        },
        name: {
          type: "string",
          description: "Short name for the skill (used when writing)."
        },
        description: {
          type: "string",
          description: "One-line description of what this skill covers (used when writing)."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization (used when writing)."
        },
        content: {
          type: "string",
          description: "Markdown body of the skill (used when writing)."
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "rules",
    description: "Manage agent rules — persistent markdown notes stored in browser storage. Use list/read/write/delete to maintain behavioral rules across sessions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "write", "delete"],
          description: "Action to perform."
        },
        id: {
          type: "string",
          description: "Rule ID. Required for read and delete. For write, if omitted a new rule is created; if provided, the existing rule is updated."
        },
        title: {
          type: "string",
          description: "Title of the rule (used when writing)."
        },
        content: {
          type: "string",
          description: "Markdown content of the rule (used when writing)."
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "ask_user_question",
    description: "Ask clarifying question(s) to the user with options (radio/checkbox) and/or free text.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The main question or prompt for the user."
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "List of recommended option strings for the user to choose from."
        },
        multiSelect: {
          type: "boolean",
          default: false,
          description: "Set to true to allow user to check multiple options."
        },
        allowFreeText: {
          type: "boolean",
          default: true,
          description: "Set to true to allow user to write custom input."
        }
      },
      required: ["question"],
      additionalProperties: false
    }
  },
  {
    name: "wait_for_user_input",
    description: "Pause until the user finishes a manual browser step, such as entering a password or uploading a file, and clicks Continue. The result includes a fresh Git-style page diff or a full snapshot if the page changed.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Tell the user what manual step to complete in the browser before continuing. Do not ask them to send sensitive values in chat."
        },
        continueLabel: {
          type: "string",
          description: "Optional label for the Continue button."
        }
      },
      required: ["message"],
      additionalProperties: false
    }
  },
  {
    name: "request_approval",
    description: "Request user approval before executing high-risk actions (e.g., submitting forms, purchases, deployments, deletions).",
    parameters: {
      type: "object",
      properties: {
        actionType: {
          type: "string",
          description: "Type of high-risk action (form_submission, purchase, deployment, deletion, message_send, file_transfer)."
        },
        description: {
          type: "string",
          description: "Explanation of what action will be performed and why approval is needed."
        },
        details: {
          type: "object",
          description: "Optional key-value context details (e.g. form inputs, target URL, element text)."
        }
      },
      required: ["actionType", "description"],
      additionalProperties: false
    }
  },
  {
    name: "continue_plan",
    description: "Explicitly continue the currently approved plan in this new conversation turn. Use this instead of submitting the same plan again. If the user's request changes the plan's scope, submit a new plan instead.",
    parameters: {
      type: "object",
      properties: {
        planId: {
          type: "string",
          description: "The planId shown in the active plan context."
        }
      },
      required: ["planId"],
      additionalProperties: false
    }
  },
  {
    name: "submit_plan",
    description: "Submit a detailed, evidence-based multi-step plan for user review before executing complex operations. Never submit generic or placeholder steps. The plan must explain what will be inspected, the exact scope and targets, expected outcomes, how each result will be verified, and what risks or assumptions could change the recommendation. If a previous plan was rejected, materially revise it and explicitly map every feedback item to a change.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Specific title naming the task and decision or outcome."
        },
        objective: {
          type: "string",
          description: "The precise question this plan will answer or outcome it will achieve."
        },
        steps: {
          type: "array",
          minItems: 3,
          items: { type: "string" },
          description: "Ordered, concrete steps. Each step must name the source/page/target, the information or action involved, and the expected result; include all relevant alternatives, not only the currently selected items."
        },
        researchTasks: {
          type: "array",
          items: { type: "string" },
          description: "Specific research or inspection tasks, including how the relevant evidence will be obtained."
        },
        deliverables: {
          type: "array",
          items: { type: "string" },
          description: "Concrete outputs the user will receive, such as comparison tables, calculations, and a recommendation with rationale."
        },
        successCriteria: {
          type: "array",
          items: { type: "string" },
          description: "Conditions that must be satisfied for the plan to be complete."
        },
        verification: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "How facts, calculations, source coverage, and the final recommendation will be checked before completion."
        },
        risks: {
          type: "array",
          items: { type: "string" },
          description: "Material risks, limitations, missing data, or situations where the agent must stop and ask the user."
        },
        assumptions: {
          type: "array",
          items: { type: "string" },
          description: "Assumptions that need confirmation, such as retirement timeline, risk tolerance, fees, or account constraints."
        },
        feedbackAddressed: {
          type: "array",
          items: { type: "string" },
          description: "For a revision, one entry for every item of user feedback and exactly how this plan addresses it. Use an empty array for the first submission or a new unrelated task."
        },
        revisionOfPlanId: {
          type: "string",
          description: "Set this to the rejected plan's planId only when this submission is a revision of that plan. Omit it for a new unrelated task."
        },
        changesFromPrevious: {
          type: "array",
          items: { type: "string" },
          description: "For a revision, list the material changes from the rejected plan. Use an empty array for the first submission."
        },
        notes: {
          type: "string",
          description: "Additional context only; notes do not substitute for detailed steps, verification, or feedback mapping."
        }
      },
      required: ["title", "objective", "steps", "verification"],
      additionalProperties: false
    }
  },
  {
    name: "record_risk_assessment",
    description: "Record a newly identified risk pattern (selector, urlPattern, action, risk level) to persist in storage for future detection.",
    parameters: {
      type: "object",
      properties: {
        patternType: {
          type: "string",
          description: "Type of risk pattern: selector, urlPattern, textPattern, inputType."
        },
        pattern: {
          type: "string",
          description: "The pattern string (e.g., CSS selector, URL glob/regex, input type, text regex)."
        },
        action: {
          type: "string",
          description: "Action associated with risk: click, submit, navigate, type_text, upload."
        },
        riskLevel: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Assessed risk level."
        },
        reason: {
          type: "string",
          description: "Reasoning for the risk classification."
        }
      },
      required: ["patternType", "pattern", "action", "riskLevel"],
      additionalProperties: false
    }
  },
  {
    name: "assess_page_risk",
    description: "Scan current page elements and URL for potential high-risk targets based on default and learned risk patterns.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

export const AGENT_TOOL_MAP = Object.fromEntries(AGENT_TOOLS.map((tool) => [tool.name, tool]));

export function getOpenAiTools() {
  return AGENT_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function makeCallId(index) {
  return `call_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncateString(value, max = 500) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function validateToolCall(rawToolCall, index = 0) {
  const errors = [];

  const id = rawToolCall && rawToolCall.id ? String(rawToolCall.id) : makeCallId(index);
  const fn = (rawToolCall && rawToolCall.function) || rawToolCall || {};
  const name = fn.name || rawToolCall?.name;

  if (!name) {
    return {
      ok: false,
      includeInAssistant: false,
      name: "unknown_tool",
      normalized: {
        id,
        type: "function",
        function: {
          name: "unknown_tool",
          arguments: "{}"
        }
      },
      args: {},
      errors: [{ path: "function.name", message: "Missing tool name." }],
      requiresImagePermission: false,
      requiresNetworkPermission: false
    };
  }

  const tool = AGENT_TOOL_MAP[name];
  let argsInput = fn.arguments ?? rawToolCall?.arguments ?? {};
  let args = argsInput;

  if (typeof argsInput === "string") {
    const trimmed = argsInput.trim();
    if (!trimmed) {
      args = {};
    } else {
      try {
        args = JSON.parse(trimmed);
      } catch (err) {
        return {
          ok: false,
          includeInAssistant: Boolean(tool),
          name: String(name),
          normalized: {
            id,
            type: "function",
            function: {
              name: String(name),
              arguments: "{}"
            }
          },
          args: {},
          errors: [
            {
              path: "function.arguments",
              message: `Arguments are not valid JSON: ${err.message}`,
              rawArguments: truncateString(argsInput, 500)
            }
          ],
          requiresImagePermission: Boolean(tool && tool.requiresImagePermission),
          requiresNetworkPermission: Boolean(tool && tool.requiresNetworkPermission)
        };
      }
    }
  }

  if (!tool) {
    return {
      ok: false,
      includeInAssistant: false,
      name: String(name),
      normalized: {
        id,
        type: "function",
        function: {
          name: String(name),
          arguments: "{}"
        }
      },
      args: args && typeof args === "object" ? args : {},
      errors: [
        {
          path: "function.name",
          message: `Unknown tool "${name}". Available tools: ${AGENT_TOOLS.map((t) => t.name).join(", ")}.`
        }
      ],
      requiresImagePermission: false,
      requiresNetworkPermission: false
    };
  }

  let result;
  try {
    result = normalizeAndValidate(args, tool.parameters || {});
  } catch (err) {
    result = {
      valid: false,
      errors: [{ path: "arguments", message: err.message }],
      value: {}
    };
  }

  let normalizedArgs = result.value;
  if (normalizedArgs === undefined || normalizedArgs === null || typeof normalizedArgs !== "object" || Array.isArray(normalizedArgs)) {
    normalizedArgs = {};
  }

  const requiresImagePermission =
    Boolean(tool.requiresImagePermission) ||
    (tool.name === "get_images" && normalizedArgs.includeBase64 === true);

  return {
    ok: result.valid,
    includeInAssistant: true,
    name: tool.name,
    normalized: {
      id,
      type: "function",
      function: {
        name: tool.name,
        arguments: JSON.stringify(normalizedArgs)
      }
    },
    args: normalizedArgs,
    errors: result.errors,
    requiresImagePermission,
    requiresNetworkPermission: Boolean(tool.requiresNetworkPermission)
  };
}
