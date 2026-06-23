// original version
/*"use client";

import { useRef } from "react";
import {
  ServerEvent,
  SessionStatus,
  AgentConfig,
  GuardrailResultType,
} from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { runGuardrailClassifier } from "@/app/lib/callOai";

export interface UseHandleServerEventParams {
  setSessionStatus: (status: SessionStatus) => void;
  selectedAgentName: string;
  selectedAgentConfigSet: AgentConfig[] | null;
  sendClientEvent: (eventObj: any, eventNameSuffix?: string) => void;
  setSelectedAgentName: (name: string) => void;
  shouldForceResponse?: boolean;
  setIsOutputAudioBufferActive: (active: boolean) => void;
}

export function useHandleServerEvent({
  setSessionStatus,
  selectedAgentName,
  selectedAgentConfigSet,
  sendClientEvent,
  setSelectedAgentName,
  setIsOutputAudioBufferActive,
}: UseHandleServerEventParams) {
  const {
    transcriptItems,
    addTranscriptBreadcrumb,
    addTranscriptMessage,
    updateTranscriptMessage,
    updateTranscriptItem,
  } = useTranscript();

  const { logServerEvent } = useEvent();

  const assistantDeltasRef = useRef<{ [itemId: string]: string }>({});

  async function processGuardrail(itemId: string, text: string) {
    let res;
    try {
      res = await runGuardrailClassifier(text);
    } catch (error) {
      console.warn(error);
      return;
    }

    const currentItem = transcriptItems.find((item) => item.itemId === itemId);
    if ((currentItem?.guardrailResult?.testText?.length ?? 0) > text.length) {
      // If the existing guardrail result is more complete, skip updating. We're running multiple guardrail checks and you don't want an earlier one to overwrite a later, more complete result.
      return;
    }
    
    const newGuardrailResult: GuardrailResultType = {
      status: "DONE",
      testText: text,
      category: res.moderationCategory,
      rationale: res.moderationRationale,
    };

    // Update the transcript item with the new guardrail result.
    updateTranscriptItem(itemId, { guardrailResult: newGuardrailResult });
  }

  const handleFunctionCall = async (functionCallParams: {
    name: string;
    call_id?: string;
    arguments: string;
  }) => {
    const args = JSON.parse(functionCallParams.arguments);
    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    addTranscriptBreadcrumb(`function call: ${functionCallParams.name}`, args);

    if (currentAgent?.toolLogic?.[functionCallParams.name]) {
      const fn = currentAgent.toolLogic[functionCallParams.name];
      const fnResult = await fn(args, transcriptItems, addTranscriptBreadcrumb);
      addTranscriptBreadcrumb(
        `function call result: ${functionCallParams.name}`,
        fnResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(fnResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    } else if (functionCallParams.name === "transferAgents") {
      const destinationAgent = args.destination_agent;
      const newAgentConfig =
        selectedAgentConfigSet?.find((a) => a.name === destinationAgent) ||
        null;
      if (newAgentConfig) {
        setSelectedAgentName(destinationAgent);
      }
      const functionCallOutput = {
        destination_agent: destinationAgent,
        did_transfer: !!newAgentConfig,
      };
      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(functionCallOutput),
        },
      });
      addTranscriptBreadcrumb(
        `function call: ${functionCallParams.name} response`,
        functionCallOutput
      );
    } else {
      const simulatedResult = { result: true };
      addTranscriptBreadcrumb(
        `function call fallback: ${functionCallParams.name}`,
        simulatedResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(simulatedResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    }
  };

  const handleServerEvent = (serverEvent: ServerEvent) => {
    logServerEvent(serverEvent);

    switch (serverEvent.type) {
      case "session.created": {
        if (serverEvent.session?.id) {
          setSessionStatus("CONNECTED");
          addTranscriptBreadcrumb(
            `session.id: ${
              serverEvent.session.id
            }\nStarted at: ${new Date().toLocaleString()}`
          );
        }
        break;
      }

      case "output_audio_buffer.started": {
        setIsOutputAudioBufferActive(true);
        break;
      }
      case "output_audio_buffer.stopped": {
        setIsOutputAudioBufferActive(false);
        break;
      }

      case "conversation.item.created": {
        let text =
          serverEvent.item?.content?.[0]?.text ||
          serverEvent.item?.content?.[0]?.transcript ||
          "";
        const role = serverEvent.item?.role as "user" | "assistant";
        const itemId = serverEvent.item?.id;

        if (itemId && transcriptItems.some((item) => item.itemId === itemId)) {
          // don't add transcript message if already exists
          break;
        }

        if (itemId && role) {
          if (role === "user" && !text) {
            text = "[Transcribing...]";
          }
          addTranscriptMessage(itemId, role, text);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const itemId = serverEvent.item_id;
        const finalTranscript =
          !serverEvent.transcript || serverEvent.transcript === "\n"
            ? "[inaudible]"
            : serverEvent.transcript;
        if (itemId) {
          updateTranscriptMessage(itemId, finalTranscript, false);
        }
        break;
      }

      case "response.audio_transcript.delta": {
        const itemId = serverEvent.item_id;
        const deltaText = serverEvent.delta || "";
        if (itemId) {
          // Update the transcript message with the new text.
          updateTranscriptMessage(itemId, deltaText, true);

          // Accumulate the deltas and run the output guardrail at regular intervals.
          if (!assistantDeltasRef.current[itemId]) {
            assistantDeltasRef.current[itemId] = "";
          }
          assistantDeltasRef.current[itemId] += deltaText;
          const newAccumulated = assistantDeltasRef.current[itemId];
          const wordCount = newAccumulated.trim().split(" ").length;

          // Run guardrail classifier every 5 words.
          if (wordCount > 0 && wordCount % 5 === 0) {
            processGuardrail(itemId, newAccumulated);
          }
        }
        break;
      }

      case "response.done": {
        if (serverEvent.response?.output) {
          serverEvent.response.output.forEach((outputItem) => {
            if (
              outputItem.type === "function_call" &&
              outputItem.name &&
              outputItem.arguments
            ) {
              handleFunctionCall({
                name: outputItem.name,
                call_id: outputItem.call_id,
                arguments: outputItem.arguments,
              });
            }
            if (
              outputItem.type === "message" &&
              outputItem.role === "assistant"
            ) {
              const itemId = outputItem.id;
              const text = outputItem.content[0].transcript;
              // Final guardrail for this message
              processGuardrail(itemId, text);
            }
          });
        }
        break;
      }

      case "response.output_item.done": {
        const itemId = serverEvent.item?.id;
        if (itemId) {
          updateTranscriptItem(itemId, { status: "DONE" });
        }
        break;
      }

      default:
        break;
    }
  };

  const handleServerEventRef = useRef(handleServerEvent);
  handleServerEventRef.current = handleServerEvent;

  return handleServerEventRef;
}*/

// 0602 Testing remove session and start at:
/*
"use client";

import { useRef } from "react";
import {
  ServerEvent,
  SessionStatus,
  AgentConfig,
  GuardrailResultType,
} from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { runGuardrailClassifier } from "@/app/lib/callOai";

export interface UseHandleServerEventParams {
  setSessionStatus: (status: SessionStatus) => void;
  selectedAgentName: string;
  selectedAgentConfigSet: AgentConfig[] | null;
  sendClientEvent: (eventObj: any, eventNameSuffix?: string) => void;
  setSelectedAgentName: (name: string) => void;
  shouldForceResponse?: boolean;
  setIsOutputAudioBufferActive: (active: boolean) => void;
}

export function useHandleServerEvent({
  setSessionStatus,
  selectedAgentName,
  selectedAgentConfigSet,
  sendClientEvent,
  setSelectedAgentName,
  setIsOutputAudioBufferActive,
}: UseHandleServerEventParams) {
  const {
    transcriptItems,
    addTranscriptBreadcrumb,
    addTranscriptMessage,
    updateTranscriptMessage,
    updateTranscriptItem,
  } = useTranscript();

  const { logServerEvent } = useEvent();

  const assistantDeltasRef = useRef<{ [itemId: string]: string }>({});

  async function processGuardrail(itemId: string, text: string) {
    let res;
    try {
      res = await runGuardrailClassifier(text);
    } catch (error) {
      console.warn(error);
      return;
    }

    const currentItem = transcriptItems.find((item) => item.itemId === itemId);
    if ((currentItem?.guardrailResult?.testText?.length ?? 0) > text.length) {
      // If the existing guardrail result is more complete, skip updating. We're running multiple guardrail checks and you don't want an earlier one to overwrite a later, more complete result.
      return;
    }
    
    const newGuardrailResult: GuardrailResultType = {
      status: "DONE",
      testText: text,
      category: res.moderationCategory,
      rationale: res.moderationRationale,
    };

    // Update the transcript item with the new guardrail result.
    updateTranscriptItem(itemId, { guardrailResult: newGuardrailResult });
  }

  const handleFunctionCall = async (functionCallParams: {
    name: string;
    call_id?: string;
    arguments: string;
  }) => {
    const args = JSON.parse(functionCallParams.arguments);
    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    addTranscriptBreadcrumb(`function call: ${functionCallParams.name}`, args);

    if (currentAgent?.toolLogic?.[functionCallParams.name]) {
      const fn = currentAgent.toolLogic[functionCallParams.name];
      const fnResult = await fn(args, transcriptItems, addTranscriptBreadcrumb);
      addTranscriptBreadcrumb(
        `function call result: ${functionCallParams.name}`,
        fnResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(fnResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    } else if (functionCallParams.name === "transferAgents") {
      const destinationAgent = args.destination_agent;
      const newAgentConfig =
        selectedAgentConfigSet?.find((a) => a.name === destinationAgent) ||
        null;
      if (newAgentConfig) {
        setSelectedAgentName(destinationAgent);
      }
      const functionCallOutput = {
        destination_agent: destinationAgent,
        did_transfer: !!newAgentConfig,
      };
      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(functionCallOutput),
        },
      });
      addTranscriptBreadcrumb(
        `function call: ${functionCallParams.name} response`,
        functionCallOutput
      );
    } else {
      const simulatedResult = { result: true };
      addTranscriptBreadcrumb(
        `function call fallback: ${functionCallParams.name}`,
        simulatedResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(simulatedResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    }
  };

  const handleServerEvent = (serverEvent: ServerEvent) => {
    logServerEvent(serverEvent);

    switch (serverEvent.type) {
      case "session.created": {
        if (serverEvent.session?.id) {
          setSessionStatus("CONNECTED");
          // 移除 session.id 和時間資訊的顯示
          // 改為添加歡迎訊息
          addTranscriptMessage("welcome", "assistant", "你好！這裡是行天宮解籤服務！你抽到的是幾號籤？");
        }
        break;
      }

      case "output_audio_buffer.started": {
        setIsOutputAudioBufferActive(true);
        break;
      }
      case "output_audio_buffer.stopped": {
        setIsOutputAudioBufferActive(false);
        break;
      }

      case "conversation.item.created": {
        let text =
          serverEvent.item?.content?.[0]?.text ||
          serverEvent.item?.content?.[0]?.transcript ||
          "";
        const role = serverEvent.item?.role as "user" | "assistant";
        const itemId = serverEvent.item?.id;

        if (itemId && transcriptItems.some((item) => item.itemId === itemId)) {
          // don't add transcript message if already exists
          break;
        }

        if (itemId && role) {
          if (role === "user" && !text) {
            text = "[Transcribing...]";
          }
          addTranscriptMessage(itemId, role, text);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const itemId = serverEvent.item_id;
        const finalTranscript =
          !serverEvent.transcript || serverEvent.transcript === "\n"
            ? "[inaudible]"
            : serverEvent.transcript;
        if (itemId) {
          updateTranscriptMessage(itemId, finalTranscript, false);
        }
        break;
      }

      case "response.audio_transcript.delta": {
        const itemId = serverEvent.item_id;
        const deltaText = serverEvent.delta || "";
        if (itemId) {
          // Update the transcript message with the new text.
          updateTranscriptMessage(itemId, deltaText, true);

          // Accumulate the deltas and run the output guardrail at regular intervals.
          if (!assistantDeltasRef.current[itemId]) {
            assistantDeltasRef.current[itemId] = "";
          }
          assistantDeltasRef.current[itemId] += deltaText;
          const newAccumulated = assistantDeltasRef.current[itemId];
          const wordCount = newAccumulated.trim().split(" ").length;

          // Run guardrail classifier every 5 words.
          if (wordCount > 0 && wordCount % 5 === 0) {
            processGuardrail(itemId, newAccumulated);
          }
        }
        break;
      }

      case "response.done": {
        if (serverEvent.response?.output) {
          serverEvent.response.output.forEach((outputItem) => {
            if (
              outputItem.type === "function_call" &&
              outputItem.name &&
              outputItem.arguments
            ) {
              handleFunctionCall({
                name: outputItem.name,
                call_id: outputItem.call_id,
                arguments: outputItem.arguments,
              });
            }
            if (
              outputItem.type === "message" &&
              outputItem.role === "assistant"
            ) {
              const itemId = outputItem.id;
              const text = outputItem.content[0].transcript;
              // Final guardrail for this message
              processGuardrail(itemId, text);
            }
          });
        }
        break;
      }

      case "response.output_item.done": {
        const itemId = serverEvent.item?.id;
        if (itemId) {
          updateTranscriptItem(itemId, { status: "DONE" });
        }
        break;
      }

      default:
        break;
    }
  };

  const handleServerEventRef = useRef(handleServerEvent);
  handleServerEventRef.current = handleServerEvent;

  return handleServerEventRef;
}*/

//1223 realtime + api/web_search + useHandleServerEvent
/*"use client";

import { useRef } from "react";
import {
  ServerEvent,
  SessionStatus,
  AgentConfig,
  GuardrailResultType,
} from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { runGuardrailClassifier } from "@/app/lib/callOai";

export interface UseHandleServerEventParams {
  setSessionStatus: (status: SessionStatus) => void;
  selectedAgentName: string;
  selectedAgentConfigSet: AgentConfig[] | null;
  sendClientEvent: (eventObj: any, eventNameSuffix?: string) => void;
  setSelectedAgentName: (name: string) => void;
  shouldForceResponse?: boolean;
  setIsOutputAudioBufferActive: (active: boolean) => void;
}

export function useHandleServerEvent({
  setSessionStatus,
  selectedAgentName,
  selectedAgentConfigSet,
  sendClientEvent,
  setSelectedAgentName,
  setIsOutputAudioBufferActive,
}: UseHandleServerEventParams) {
  const {
    transcriptItems,
    addTranscriptBreadcrumb,
    addTranscriptMessage,
    updateTranscriptMessage,
    updateTranscriptItem,
  } = useTranscript();

  const { logServerEvent } = useEvent();

  const assistantDeltasRef = useRef<{ [itemId: string]: string }>({});

  async function processGuardrail(itemId: string, text: string) {
    let res;
    try {
      res = await runGuardrailClassifier(text);
    } catch (error) {
      console.warn(error);
      return;
    }

    const currentItem = transcriptItems.find((item) => item.itemId === itemId);
    if ((currentItem?.guardrailResult?.testText?.length ?? 0) > text.length) {
      // If the existing guardrail result is more complete, skip updating.
      return;
    }

    const newGuardrailResult: GuardrailResultType = {
      status: "DONE",
      testText: text,
      category: res.moderationCategory,
      rationale: res.moderationRationale,
    };

    updateTranscriptItem(itemId, { guardrailResult: newGuardrailResult });
  }

  const handleFunctionCall = async (functionCallParams: {
    name: string;
    call_id?: string;
    arguments: string;
  }) => {
    // ✅ Safe JSON parse
    let args: any = {};
    try {
      args =
        typeof functionCallParams.arguments === "string"
          ? JSON.parse(functionCallParams.arguments || "{}")
          : functionCallParams.arguments || {};
    } catch (err) {
      console.warn("Failed to parse function_call arguments:", err);
      args = {};
    }

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    addTranscriptBreadcrumb(`function call: ${functionCallParams.name}`, args);

    try {
      // ✅ 1) 若 agentConfig 有 toolLogic，照原本走
      if (currentAgent?.toolLogic?.[functionCallParams.name]) {
        const fn = currentAgent.toolLogic[functionCallParams.name];
        const fnResult = await fn(args, transcriptItems, addTranscriptBreadcrumb);

        addTranscriptBreadcrumb(
          `function call result: ${functionCallParams.name}`,
          fnResult
        );

        sendClientEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: functionCallParams.call_id,
            output: JSON.stringify(fnResult),
          },
        });
        sendClientEvent({ type: "response.create" });
        return;
      }

      // ✅ 2) 新增：web_search 直接打你後端 /api/web_search
      if (functionCallParams.name === "web_search") {
        const query = String(args?.query || "").trim();
        const recency_days =
          Number.isFinite(args?.recency_days) ? Number(args.recency_days) : 30;
        const domains = Array.isArray(args?.domains) ? args.domains : undefined;

        if (!query) {
          const errOut = { error: "Missing query for web_search" };
          addTranscriptBreadcrumb("function call result: web_search", errOut);

          sendClientEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: functionCallParams.call_id,
              output: JSON.stringify(errOut),
            },
          });
          sendClientEvent({ type: "response.create" });
          return;
        }

        const res = await fetch("/api/web_search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, recency_days, domains }),
        });

        let data: any = null;
        try {
          data = await res.json();
        } catch (err) {
          data = { error: `Failed to parse JSON: ${String(err)}` };
        }

        if (!res.ok) {
          data = {
            error: "web_search failed",
            status: res.status,
            statusText: res.statusText,
            details: data,
          };
        }

        addTranscriptBreadcrumb("function call result: web_search", data);

        sendClientEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: functionCallParams.call_id,
            output: JSON.stringify(data).slice(0, 20000), // 防止過大
          },
        });

        // ✅ 重要：再觸發一次 response.create，讓 Realtime 用結果回答
        sendClientEvent({ type: "response.create" });
        return;
      }

      // ✅ 3) 原本 transferAgents 邏輯保留
      if (functionCallParams.name === "transferAgents") {
        const destinationAgent = args.destination_agent;
        const newAgentConfig =
          selectedAgentConfigSet?.find((a) => a.name === destinationAgent) ||
          null;
        if (newAgentConfig) {
          setSelectedAgentName(destinationAgent);
        }
        const functionCallOutput = {
          destination_agent: destinationAgent,
          did_transfer: !!newAgentConfig,
        };
        sendClientEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: functionCallParams.call_id,
            output: JSON.stringify(functionCallOutput),
          },
        });
        addTranscriptBreadcrumb(
          `function call: ${functionCallParams.name} response`,
          functionCallOutput
        );
        return;
      }

      // ✅ 4) 其餘工具才 fallback（避免 web_search 被 fallback）
      const simulatedResult = { result: true };
      addTranscriptBreadcrumb(
        `function call fallback: ${functionCallParams.name}`,
        simulatedResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(simulatedResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    } catch (err) {
      console.error("handleFunctionCall error:", err);
      const errOut = { error: String(err) };

      addTranscriptBreadcrumb(
        `function call error: ${functionCallParams.name}`,
        errOut
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(errOut),
        },
      });
      sendClientEvent({ type: "response.create" });
    }
  };

  const handleServerEvent = (serverEvent: ServerEvent) => {
    logServerEvent(serverEvent);

    switch (serverEvent.type) {
      case "session.created": {
        if (serverEvent.session?.id) {
          setSessionStatus("CONNECTED");
          addTranscriptMessage(
            "welcome",
            "assistant",
            "您好！我是一路發，這是我的 AI 服務專線，歡迎您。"
          );
        }
        break;
      }

      case "output_audio_buffer.started": {
        setIsOutputAudioBufferActive(true);
        break;
      }
      case "output_audio_buffer.stopped": {
        setIsOutputAudioBufferActive(false);
        break;
      }

      case "conversation.item.created": {
        let text =
          serverEvent.item?.content?.[0]?.text ||
          serverEvent.item?.content?.[0]?.transcript ||
          "";
        const role = serverEvent.item?.role as "user" | "assistant";
        const itemId = serverEvent.item?.id;

        if (itemId && transcriptItems.some((item) => item.itemId === itemId)) {
          break;
        }

        if (itemId && role) {
          if (role === "user" && !text) {
            text = "[Transcribing...]";
          }
          addTranscriptMessage(itemId, role, text);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const itemId = serverEvent.item_id;
        const finalTranscript =
          !serverEvent.transcript || serverEvent.transcript === "\n"
            ? "[inaudible]"
            : serverEvent.transcript;
        if (itemId) {
          updateTranscriptMessage(itemId, finalTranscript, false);
        }
        break;
      }

      case "response.audio_transcript.delta": {
        const itemId = serverEvent.item_id;
        const deltaText = serverEvent.delta || "";
        if (itemId) {
          updateTranscriptMessage(itemId, deltaText, true);

          if (!assistantDeltasRef.current[itemId]) {
            assistantDeltasRef.current[itemId] = "";
          }
          assistantDeltasRef.current[itemId] += deltaText;
          const newAccumulated = assistantDeltasRef.current[itemId];
          const wordCount = newAccumulated.trim().split(" ").length;

          if (wordCount > 0 && wordCount % 5 === 0) {
            processGuardrail(itemId, newAccumulated);
          }
        }
        break;
      }

      case "response.done": {
        if (serverEvent.response?.output) {
          // ✅ 用 for..of，確保 function_call 內部 async 不會被 forEach 吃掉
          for (const outputItem of serverEvent.response.output as any[]) {
            if (
              outputItem.type === "function_call" &&
              outputItem.name &&
              outputItem.arguments
            ) {
              // 不阻塞 UI：但 handleFunctionCall 內部會自己處理 try/catch
              void handleFunctionCall({
                name: outputItem.name,
                call_id: outputItem.call_id,
                arguments: outputItem.arguments,
              });
            }

            if (outputItem.type === "message" && outputItem.role === "assistant") {
              const itemId = outputItem.id;
              const text = outputItem.content?.[0]?.transcript || "";
              if (itemId && text) {
                processGuardrail(itemId, text);
              }
            }
          }
        }
        break;
      }

      case "response.output_item.done": {
        const itemId = serverEvent.item?.id;
        if (itemId) {
          updateTranscriptItem(itemId, { status: "DONE" });
        }
        break;
      }

      default:
        break;
    }
  };

  const handleServerEventRef = useRef(handleServerEvent);
  handleServerEventRef.current = handleServerEvent;

  return handleServerEventRef;
}*/

// 0623 testing

"use client";

import { useRef } from "react";
import {
  ServerEvent,
  SessionStatus,
  AgentConfig,
  GuardrailResultType,
} from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { runGuardrailClassifier } from "@/app/lib/callOai";

export interface UseHandleServerEventParams {
  setSessionStatus: (status: SessionStatus) => void;
  selectedAgentName: string;
  selectedAgentConfigSet: AgentConfig[] | null;
  sendClientEvent: (eventObj: any, eventNameSuffix?: string) => void;
  setSelectedAgentName: (name: string) => void;
  shouldForceResponse?: boolean;
  setIsOutputAudioBufferActive: (active: boolean) => void;
}

type TranscriptRole = "user" | "assistant";

export function useHandleServerEvent({
  setSessionStatus,
  selectedAgentName,
  selectedAgentConfigSet,
  sendClientEvent,
  setSelectedAgentName,
  setIsOutputAudioBufferActive,
}: UseHandleServerEventParams) {
  const {
    transcriptItems,
    addTranscriptBreadcrumb,
    addTranscriptMessage,
    updateTranscriptMessage,
    updateTranscriptItem,
  } = useTranscript();

  const { logServerEvent } = useEvent();

  const assistantDeltasRef = useRef<{ [itemId: string]: string }>({});
  const handledFunctionCallIdsRef = useRef<Set<string>>(new Set());

  const responseItemIdByResponseIdRef = useRef<Record<string, string>>({});

  function transcriptItemExists(itemId?: string) {
    if (!itemId) return false;
    return transcriptItems.some(
      (item) => item.itemId === itemId && item.type === "MESSAGE"
    );
  }

  function resolveAssistantItemId(event: any): string | undefined {
    return (
      event.item_id ||
      event.output_item_id ||
      event.item?.id ||
      (event.response_id
        ? responseItemIdByResponseIdRef.current[event.response_id]
        : undefined) ||
      event.response_id
    );
  }

  function extractTextFromContent(content: any): string {
    if (!content) return "";

    const list = Array.isArray(content) ? content : [content];

    return list
      .map((part: any) => {
        if (!part) return "";
        if (typeof part === "string") return part;

        return (
          part.text ||
          part.transcript ||
          part.output_text ||
          part.input_text ||
          part.audio?.transcript ||
          ""
        );
      })
      .filter(Boolean)
      .join("");
  }

  function extractAssistantTextFromOutputItem(outputItem: any): string {
    if (!outputItem) return "";

    if (outputItem.type === "text" && outputItem.text) {
      return outputItem.text;
    }

    if (outputItem.content) {
      return extractTextFromContent(outputItem.content);
    }

    return "";
  }

  function appendAssistantDelta(itemId: string | undefined, deltaText: string) {
    if (!itemId || !deltaText) return;

    if (!transcriptItemExists(itemId)) {
      addTranscriptMessage(itemId, "assistant", "");
    }

    updateTranscriptMessage(itemId, deltaText, true);

    if (!assistantDeltasRef.current[itemId]) {
      assistantDeltasRef.current[itemId] = "";
    }

    assistantDeltasRef.current[itemId] += deltaText;

    const newAccumulated = assistantDeltasRef.current[itemId];
    const wordCount = newAccumulated.trim().split(/\s+/).filter(Boolean).length;

    if (wordCount > 0 && wordCount % 5 === 0) {
      processGuardrail(itemId, newAccumulated);
    }
  }

  async function processGuardrail(itemId: string, text: string) {
    if (!text?.trim()) return;

    let res;
    try {
      res = await runGuardrailClassifier(text);
    } catch (error) {
      console.warn(error);
      return;
    }

    const currentItem = transcriptItems.find((item) => item.itemId === itemId);
    if ((currentItem?.guardrailResult?.testText?.length ?? 0) > text.length) {
      return;
    }

    const newGuardrailResult: GuardrailResultType = {
      status: "DONE",
      testText: text,
      category: res.moderationCategory,
      rationale: res.moderationRationale,
    };

    updateTranscriptItem(itemId, { guardrailResult: newGuardrailResult });
  }

  const handleFunctionCall = async (functionCallParams: {
    name: string;
    call_id?: string;
    arguments: string;
  }) => {
    let args: any = {};

    try {
      args =
        typeof functionCallParams.arguments === "string"
          ? JSON.parse(functionCallParams.arguments || "{}")
          : functionCallParams.arguments || {};
    } catch (err) {
      console.warn("Failed to parse function_call arguments:", err);
      args = {};
    }

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    addTranscriptBreadcrumb(`function call: ${functionCallParams.name}`, args);

    try {
      if (currentAgent?.toolLogic?.[functionCallParams.name]) {
        const fn = currentAgent.toolLogic[functionCallParams.name];
        const fnResult = await fn(args, transcriptItems, addTranscriptBreadcrumb);

        addTranscriptBreadcrumb(
          `function call result: ${functionCallParams.name}`,
          fnResult
        );

        sendClientEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: functionCallParams.call_id,
            output: JSON.stringify(fnResult),
          },
        });

        sendClientEvent({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
          },
        });
        return;
      }

      if (functionCallParams.name === "web_search") {
        const query = String(args?.query || "").trim();
        const recency_days =
          Number.isFinite(args?.recency_days) ? Number(args.recency_days) : 30;
        const domains = Array.isArray(args?.domains) ? args.domains : undefined;

        if (!query) {
          const errOut = { error: "Missing query for web_search" };
          addTranscriptBreadcrumb("function call result: web_search", errOut);

          sendClientEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: functionCallParams.call_id,
              output: JSON.stringify(errOut),
            },
          });

          sendClientEvent({
            type: "response.create",
            response: {
              output_modalities: ["audio"],
            },
          });
          return;
        }

        const res = await fetch("/api/web_search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, recency_days, domains }),
        });

        let data: any = null;

        try {
          data = await res.json();
        } catch (err) {
          data = { error: `Failed to parse JSON: ${String(err)}` };
        }

        if (!res.ok) {
          data = {
            error: "web_search failed",
            status: res.status,
            statusText: res.statusText,
            details: data,
          };
        }

        addTranscriptBreadcrumb("function call result: web_search", data);

        sendClientEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: functionCallParams.call_id,
            output: JSON.stringify(data).slice(0, 20000),
          },
        });

        sendClientEvent({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
          },
        });
        return;
      }

      if (functionCallParams.name === "transferAgents") {
        const destinationAgent = args.destination_agent;
        const newAgentConfig =
          selectedAgentConfigSet?.find((a) => a.name === destinationAgent) ||
          null;

        if (newAgentConfig) {
          setSelectedAgentName(destinationAgent);
        }

        const functionCallOutput = {
          destination_agent: destinationAgent,
          did_transfer: !!newAgentConfig,
        };

        sendClientEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: functionCallParams.call_id,
            output: JSON.stringify(functionCallOutput),
          },
        });

        addTranscriptBreadcrumb(
          `function call: ${functionCallParams.name} response`,
          functionCallOutput
        );
        return;
      }

      const simulatedResult = { result: true };

      addTranscriptBreadcrumb(
        `function call fallback: ${functionCallParams.name}`,
        simulatedResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(simulatedResult),
        },
      });

      sendClientEvent({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
        },
      });
    } catch (err) {
      console.error("handleFunctionCall error:", err);

      const errOut = { error: String(err) };

      addTranscriptBreadcrumb(
        `function call error: ${functionCallParams.name}`,
        errOut
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(errOut),
        },
      });

      sendClientEvent({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
        },
      });
    }
  };

  const handleServerEvent = (serverEvent: ServerEvent) => {
    const event: any = serverEvent;
    logServerEvent(serverEvent);

    switch (event.type) {
      case "session.created": {
        if (event.session?.id) {
          setSessionStatus("CONNECTED");
        }
        break;
      }

      case "session.updated": {
        setSessionStatus("CONNECTED");
        break;
      }

      case "output_audio_buffer.started": {
        setIsOutputAudioBufferActive(true);
        break;
      }

      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": {
        setIsOutputAudioBufferActive(false);
        break;
      }

      case "conversation.item.created":
      case "conversation.item.added": {
        const item = event.item;
        const role = item?.role as TranscriptRole | undefined;
        const itemId = item?.id;
        let text = extractTextFromContent(item?.content);

        if (!itemId || !role) break;

        if (transcriptItemExists(itemId)) {
          if (text) updateTranscriptMessage(itemId, text, false);
          break;
        }

        if (role === "user" && !text) {
          text = "[Transcribing...]";
        }

        addTranscriptMessage(itemId, role, text);
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const itemId = event.item_id;
        const finalTranscript =
          !event.transcript || event.transcript === "\n"
            ? "[inaudible]"
            : event.transcript;

        if (itemId) {
          if (!transcriptItemExists(itemId)) {
            addTranscriptMessage(itemId, "user", finalTranscript);
          } else {
            updateTranscriptMessage(itemId, finalTranscript, false);
          }

          updateTranscriptItem(itemId, { status: "DONE" });
        }
        break;
      }

      case "conversation.item.input_audio_transcription.failed": {
        const itemId = event.item_id;

        if (itemId) {
          if (!transcriptItemExists(itemId)) {
            addTranscriptMessage(itemId, "user", "[inaudible]");
          } else {
            updateTranscriptMessage(itemId, "[inaudible]", false);
          }

          updateTranscriptItem(itemId, { status: "DONE" });
        }
        break;
      }

      case "response.output_item.added": {
        const item = event.item;
        const itemId = item?.id;
        const role = item?.role as TranscriptRole | undefined;

        if (itemId && role === "assistant" && event.response_id) {
          responseItemIdByResponseIdRef.current[event.response_id] = itemId;
        }

        break;
      }

      case "response.content_part.added": {
        const itemId = resolveAssistantItemId(event);
        const partText = extractTextFromContent(event.part);

        if (itemId && partText) {
          appendAssistantDelta(itemId, partText);
        }
        break;
      }

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
      case "response.text.delta":
      case "response.output_text.delta": {
        const itemId = resolveAssistantItemId(event);
        const deltaText = event.delta || "";

        appendAssistantDelta(itemId, deltaText);
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
      case "response.text.done":
      case "response.output_text.done": {
        const itemId = resolveAssistantItemId(event);
        const transcript = event.transcript || event.text || "";

        if (itemId && transcript) {
          if (!transcriptItemExists(itemId)) {
            addTranscriptMessage(itemId, "assistant", transcript);
          } else {
            updateTranscriptMessage(itemId, transcript, false);
          }

          updateTranscriptItem(itemId, { status: "DONE" });
          processGuardrail(itemId, transcript);
        }
        break;
      }

      case "response.content_part.done": {
        const itemId = resolveAssistantItemId(event);
        const partText = extractTextFromContent(event.part);

        if (itemId && partText) {
          if (!transcriptItemExists(itemId)) {
            addTranscriptMessage(itemId, "assistant", partText);
          } else {
            updateTranscriptMessage(itemId, partText, false);
          }

          updateTranscriptItem(itemId, { status: "DONE" });
        }
        break;
      }

      case "response.output_item.done": {
        const item = event.item;
        const itemId = item?.id;
        const role = item?.role as TranscriptRole | undefined;
        const text = extractTextFromContent(item?.content);

        if (itemId) {
          if (role === "assistant" && text) {
            if (!transcriptItemExists(itemId)) {
              addTranscriptMessage(itemId, "assistant", text);
            } else {
              updateTranscriptMessage(itemId, text, false);
            }

            processGuardrail(itemId, text);
          }

          updateTranscriptItem(itemId, { status: "DONE" });
        }
        break;
      }

      case "response.done":
      case "response.completed": {
        if (event.response?.output) {
          for (const outputItem of event.response.output as any[]) {
            if (
              outputItem.type === "function_call" &&
              outputItem.name &&
              outputItem.arguments
            ) {
              const callId =
                outputItem.call_id || `${outputItem.name}_${outputItem.arguments}`;

              if (!handledFunctionCallIdsRef.current.has(callId)) {
                handledFunctionCallIdsRef.current.add(callId);

                void handleFunctionCall({
                  name: outputItem.name,
                  call_id: outputItem.call_id,
                  arguments: outputItem.arguments,
                });
              }
            }

            if (outputItem.type === "message" && outputItem.role === "assistant") {
              const itemId = outputItem.id;
              const text = extractAssistantTextFromOutputItem(outputItem);

              if (itemId && text) {
                if (!transcriptItemExists(itemId)) {
                  addTranscriptMessage(itemId, "assistant", text);
                } else {
                  updateTranscriptMessage(itemId, text, false);
                }

                updateTranscriptItem(itemId, { status: "DONE" });
                processGuardrail(itemId, text);
              }
            }
          }
        }
        break;
      }

      default:
        break;
    }
  };

  const handleServerEventRef = useRef(handleServerEvent);
  handleServerEventRef.current = handleServerEvent;

  return handleServerEventRef;
}

