/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";
import BottomToolbar from "./components/BottomToolbar";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Utilities
import { createRealtimeConnection } from "./lib/realtimeConnection";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  // Use urlCodec directly from URL search params (default: "opus")
  const urlCodec = searchParams.get("codec") || "opus";

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  // Changed default to false to hide logs by default
  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dcRef.current.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTACtive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      console.error("No ephemeral key provided by the server");
      setSessionStatus("DISCONNECTED");
      return null;
    }

    return data.client_secret.value;
  };

  const connectToRealtime = async () => {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) {
        return;
      }

      if (!audioElementRef.current) {
        audioElementRef.current = document.createElement("audio");
      }
      audioElementRef.current.autoplay = isAudioPlaybackEnabled;

      const { pc, dc } = await createRealtimeConnection(
        EPHEMERAL_KEY,
        audioElementRef,
        urlCodec
      );
      pcRef.current = pc;
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      setDataChannel(dc);
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  };

  const disconnectFromRealtime = () => {
    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });

      pcRef.current.close();
      pcRef.current = null;
    }
    setDataChannel(null);
    setSessionStatus("DISCONNECTED");
    setIsPTTUserSpeaking(false);

    logClientEvent({}, "disconnected");
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("hi");
    }
  };

  const cancelAssistantSpeech = async () => {
    // Send a response.cancel if the most recent assistant conversation item is IN_PROGRESS. This implicitly does a item.truncate as well
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");


    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    // Send an output_audio_buffer.cancel if the isOutputAudioBufferActive is True
    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newAgentConfig = e.target.value;
    const url = new URL(window.location.toString());
    url.searchParams.set("agentConfig", newAgentConfig);
    window.location.replace(url.toString());
  };

  const handleSelectedAgentChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newAgentName = e.target.value;
    setSelectedAgentName(newAgentName);
  };

  // Instead of using setCodec, we update the URL and refresh the page when codec changes
  const handleCodecChange = (newCodec: string) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("codec", newCodec);
    window.location.replace(url.toString());
  };

  useEffect(() => {
    const storedPushToTalkUI = localStorage.getItem("pushToTalkUI");
    if (storedPushToTalkUI) {
      setIsPTTActive(storedPushToTalkUI === "true");
    }
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      // If no stored value, default to false (logs hidden)
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElementRef.current?.srcObject) {
      // The remote audio stream from the audio element.
      const remoteStream = audioElementRef.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    // Clean up on unmount or when sessionStatus is updated.
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  const agentSetKey = searchParams.get("agentConfig") || "default";

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/openai-logomark.svg"
              alt="OpenAI Logo"
              width={20}
              height={20}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>
        <div className="flex items-center">
          <label className="flex items-center text-base gap-1 mr-2 font-medium">
            Scenario
          </label>
          <div className="relative inline-block">
            <select
              value={agentSetKey}
              onChange={handleAgentChange}
              className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
            >
              {Object.keys(allAgentSets).map((agentKey) => (
                <option key={agentKey} value={agentKey}>
                  {agentKey}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>

          {agentSetKey && (
            <div className="flex items-center ml-6">
              <label className="flex items-center text-base gap-1 mr-2 font-medium">
                Agent
              </label>
              <div className="relative inline-block">
                <select
                  value={selectedAgentName}
                  onChange={handleSelectedAgentChange}
                  className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
                >
                  {selectedAgentConfigSet?.map((agent) => (
                    <option key={agent.name} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
          sessionStatus === "CONNECTED" &&
          dcRef.current?.readyState === "open"
          }
        // Add these new props
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
    </div>
  );
}

export default App;*/

// 0524 Testing Push to Talk always checked ----------> final version checkpoint

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";
import BottomToolbar from "./components/BottomToolbar";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Utilities
import { createRealtimeConnection } from "./lib/realtimeConnection";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  // Use urlCodec directly from URL search params (default: "opus")
  const urlCodec = searchParams.get("codec") || "opus";

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  // Changed default to false to hide logs by default
  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  // Force PTT to always be active - set initial state to true
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dcRef.current.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTACtive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      console.error("No ephemeral key provided by the server");
      setSessionStatus("DISCONNECTED");
      return null;
    }

    return data.client_secret.value;
  };

  const connectToRealtime = async () => {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) {
        return;
      }

      if (!audioElementRef.current) {
        audioElementRef.current = document.createElement("audio");
      }
      audioElementRef.current.autoplay = isAudioPlaybackEnabled;

      const { pc, dc } = await createRealtimeConnection(
        EPHEMERAL_KEY,
        audioElementRef,
        urlCodec
      );
      pcRef.current = pc;
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      setDataChannel(dc);
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  };

  const disconnectFromRealtime = () => {
    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });

      pcRef.current.close();
      pcRef.current = null;
    }
    setDataChannel(null);
    setSessionStatus("DISCONNECTED");
    setIsPTTUserSpeaking(false);

    logClientEvent({}, "disconnected");
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("hi");
    }
  };

  const cancelAssistantSpeech = async () => {
    // Send a response.cancel if the most recent assistant conversation item is IN_PROGRESS. This implicitly does a item.truncate as well
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");


    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    // Send an output_audio_buffer.cancel if the isOutputAudioBufferActive is True
    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newAgentConfig = e.target.value;
    const url = new URL(window.location.toString());
    url.searchParams.set("agentConfig", newAgentConfig);
    window.location.replace(url.toString());
  };

  const handleSelectedAgentChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newAgentName = e.target.value;
    setSelectedAgentName(newAgentName);
  };

  // Instead of using setCodec, we update the URL and refresh the page when codec changes
  const handleCodecChange = (newCodec: string) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("codec", newCodec);
    window.location.replace(url.toString());
  };

  useEffect(() => {
    // Always set PTT to true and ignore localStorage for PTT setting
    setIsPTTActive(true);
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      // If no stored value, default to false (logs hidden)
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  // Remove the effect that saves PTT state to localStorage since we want it always true
  // useEffect(() => {
  //   localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  // }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElementRef.current?.srcObject) {
      // The remote audio stream from the audio element.
      const remoteStream = audioElementRef.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    // Clean up on unmount or when sessionStatus is updated.
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  const agentSetKey = searchParams.get("agentConfig") || "default";

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/openai-logomark.svg"
              alt="OpenAI Logo"
              width={20}
              height={20}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>
        <div className="flex items-center">
          <label className="flex items-center text-base gap-1 mr-2 font-medium">
            Scenario
          </label>
          <div className="relative inline-block">
            <select
              value={agentSetKey}
              onChange={handleAgentChange}
              className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
            >
              {Object.keys(allAgentSets).map((agentKey) => (
                <option key={agentKey} value={agentKey}>
                  {agentKey}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>

          {agentSetKey && (
            <div className="flex items-center ml-6">
              <label className="flex items-center text-base gap-1 mr-2 font-medium">
                Agent
              </label>
              <div className="relative inline-block">
                <select
                  value={selectedAgentName}
                  onChange={handleSelectedAgentChange}
                  className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
                >
                  {selectedAgentConfigSet?.map((agent) => (
                    <option key={agent.name} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
          sessionStatus === "CONNECTED" &&
          dcRef.current?.readyState === "open"
          }
        // Add these new props
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
    </div>
  );
}

export default App;*/

// 0524 Testing V2 change the microphone icon ---------> final version checkpoint icon

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";
import BottomToolbar from "./components/BottomToolbar";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Utilities
import { createRealtimeConnection } from "./lib/realtimeConnection";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  // Use urlCodec directly from URL search params (default: "opus")
  const urlCodec = searchParams.get("codec") || "opus";

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  // Changed default to false to hide logs by default
  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  // Force PTT to always be active - set initial state to true
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dcRef.current.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTACtive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      console.error("No ephemeral key provided by the server");
      setSessionStatus("DISCONNECTED");
      return null;
    }

    return data.client_secret.value;
  };

  const connectToRealtime = async () => {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) {
        return;
      }

      if (!audioElementRef.current) {
        audioElementRef.current = document.createElement("audio");
      }
      audioElementRef.current.autoplay = isAudioPlaybackEnabled;

      const { pc, dc } = await createRealtimeConnection(
        EPHEMERAL_KEY,
        audioElementRef,
        urlCodec
      );
      pcRef.current = pc;
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      setDataChannel(dc);
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  };

  const disconnectFromRealtime = () => {
    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });

      pcRef.current.close();
      pcRef.current = null;
    }
    setDataChannel(null);
    setSessionStatus("DISCONNECTED");
    setIsPTTUserSpeaking(false);

    logClientEvent({}, "disconnected");
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("hi");
    }
  };

  const cancelAssistantSpeech = async () => {
    // Send a response.cancel if the most recent assistant conversation item is IN_PROGRESS. This implicitly does a item.truncate as well
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");


    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    // Send an output_audio_buffer.cancel if the isOutputAudioBufferActive is True
    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newAgentConfig = e.target.value;
    const url = new URL(window.location.toString());
    url.searchParams.set("agentConfig", newAgentConfig);
    window.location.replace(url.toString());
  };

  const handleSelectedAgentChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newAgentName = e.target.value;
    setSelectedAgentName(newAgentName);
  };

  // Instead of using setCodec, we update the URL and refresh the page when codec changes
  const handleCodecChange = (newCodec: string) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("codec", newCodec);
    window.location.replace(url.toString());
  };

  useEffect(() => {
    // Always set PTT to true and ignore localStorage for PTT setting
    setIsPTTActive(true);
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      // If no stored value, default to false (logs hidden)
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  // Remove the effect that saves PTT state to localStorage since we want it always true
  // useEffect(() => {
  //   localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  // }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElementRef.current?.srcObject) {
      // The remote audio stream from the audio element.
      const remoteStream = audioElementRef.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    // Clean up on unmount or when sessionStatus is updated.
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  const agentSetKey = searchParams.get("agentConfig") || "default";

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/openai-logomark.svg"
              alt="OpenAI Logo"
              width={20}
              height={20}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>
        <div className="flex items-center">
          <label className="flex items-center text-base gap-1 mr-2 font-medium">
            Scenario
          </label>
          <div className="relative inline-block">
            <select
              value={agentSetKey}
              onChange={handleAgentChange}
              className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
            >
              {Object.keys(allAgentSets).map((agentKey) => (
                <option key={agentKey} value={agentKey}>
                  {agentKey}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>

          {agentSetKey && (
            <div className="flex items-center ml-6">
              <label className="flex items-center text-base gap-1 mr-2 font-medium">
                Agent
              </label>
              <div className="relative inline-block">
                <select
                  value={selectedAgentName}
                  onChange={handleSelectedAgentChange}
                  className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
                >
                  {selectedAgentConfigSet?.map((agent) => (
                    <option key={agent.name} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
          sessionStatus === "CONNECTED" &&
          dcRef.current?.readyState === "open"
          }
        // Add these new props
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
    </div>
  );
}

export default App;*/

// 0524 Testing vanished the scenario, Agent, BottomToolUp --------------------> final version but not limit max height

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Utilities
import { createRealtimeConnection } from "./lib/realtimeConnection";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  // Use urlCodec directly from URL search params (default: "opus")
  const urlCodec = searchParams.get("codec") || "opus";

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  // Changed default to false to hide logs by default
  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  // Force PTT to always be active - set initial state to true
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dcRef.current.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTACtive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      console.error("No ephemeral key provided by the server");
      setSessionStatus("DISCONNECTED");
      return null;
    }

    return data.client_secret.value;
  };

  const connectToRealtime = async () => {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) {
        return;
      }

      if (!audioElementRef.current) {
        audioElementRef.current = document.createElement("audio");
      }
      audioElementRef.current.autoplay = isAudioPlaybackEnabled;

      const { pc, dc } = await createRealtimeConnection(
        EPHEMERAL_KEY,
        audioElementRef,
        urlCodec
      );
      pcRef.current = pc;
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      setDataChannel(dc);
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  };



  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("hi");
    }
  };

  const cancelAssistantSpeech = async () => {
    // Send a response.cancel if the most recent assistant conversation item is IN_PROGRESS. This implicitly does a item.truncate as well
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");


    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    // Send an output_audio_buffer.cancel if the isOutputAudioBufferActive is True
    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  useEffect(() => {
    // Always set PTT to true and ignore localStorage for PTT setting
    setIsPTTActive(true);
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      // If no stored value, default to false (logs hidden)
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  // Remove the effect that saves PTT state to localStorage since we want it always true
  // useEffect(() => {
  //   localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  // }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElementRef.current?.srcObject) {
      // The remote audio stream from the audio element.
      const remoteStream = audioElementRef.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    // Clean up on unmount or when sessionStatus is updated.
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
          sessionStatus === "CONNECTED" &&
          dcRef.current?.readyState === "open"
          }
        // Add these new props
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

export default App;*/

// 0524 Testing V5 limit Max height -----> one question, one answer version

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Utilities
import { createRealtimeConnection } from "./lib/realtimeConnection";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  // Use urlCodec directly from URL search params (default: "opus")
  const urlCodec = searchParams.get("codec") || "opus";

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  // Changed default to false to hide logs by default
  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  // Force PTT to always be active - set initial state to true
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dcRef.current.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTACtive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      console.error("No ephemeral key provided by the server");
      setSessionStatus("DISCONNECTED");
      return null;
    }

    return data.client_secret.value;
  };

  const connectToRealtime = async () => {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) {
        return;
      }

      if (!audioElementRef.current) {
        audioElementRef.current = document.createElement("audio");
      }
      audioElementRef.current.autoplay = isAudioPlaybackEnabled;

      const { pc, dc } = await createRealtimeConnection(
        EPHEMERAL_KEY,
        audioElementRef,
        urlCodec
      );
      pcRef.current = pc;
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      setDataChannel(dc);
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    // Send a response.cancel if the most recent assistant conversation item is IN_PROGRESS. This implicitly does a item.truncate as well
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    // Send an output_audio_buffer.cancel if the isOutputAudioBufferActive is True
    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  useEffect(() => {
    // Always set PTT to true and ignore localStorage for PTT setting
    setIsPTTActive(true);
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      // If no stored value, default to false (logs hidden)
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  // Remove the effect that saves PTT state to localStorage since we want it always true
  // useEffect(() => {
  //   localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  // }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElementRef.current?.srcObject) {
      // The remote audio stream from the audio element.
      const remoteStream = audioElementRef.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    // Clean up on unmount or when sessionStatus is updated.
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh', // 使用動態視窗高度，在移動端更準確
           maxHeight: '100dvh'
         }}>
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>
      </div>

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
          sessionStatus === "CONNECTED" &&
          dcRef.current?.readyState === "open"
          }
        // Add these new props
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

export default App;*/

// 0529 Testing RTC version 

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTACtive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 簡化的連接函數
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      pc.addTrack(ms.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      const answer: RTCSessionDescriptionInit = {
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
    };
      await pc.setRemoteDescription(answer);

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
  }

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  useEffect(() => {
    setIsPTTActive(true);
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>
        
        {}
        {sessionStatus === "CONNECTED" && (
          <button
            onClick={stopSession}
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
          >
            斷線
          </button>
        )}
      </div>

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

export default App;*/

// 0529 Testing RTC and session verion

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 簡化的連接函數
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      pc.addTrack(ms.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
  }

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 從 localStorage 讀取之前保存的模式，默認為 VAD 模式
    const storedMode = localStorage.getItem("conversationMode");
    if (storedMode) {
      setIsPTTActive(storedMode === "PTT");
    } else {
      setIsPTTActive(false); // 默認使用 VAD 模式（持續對話）
      localStorage.setItem("conversationMode", "VAD");
    }
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={toggleConversationMode}
            className={`px-4 py-2 rounded-lg font-medium transition-all duration-200 ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md' 
                : 'bg-green-500 text-white hover:bg-green-600 shadow-md'
            }`}
            title={isPTTActive ? "點擊切換到持續對話模式" : "點擊切換到按住說話模式"}
          >
            {isPTTActive ? '🎙️ 按住說話' : '🔊 持續對話'}
          </button>

          {}
          <div className={`px-3 py-1 rounded-full text-sm font-medium ${
            sessionStatus === "CONNECTED" 
              ? 'bg-green-100 text-green-800' 
              : sessionStatus === "CONNECTING"
              ? 'bg-yellow-100 text-yellow-800'
              : 'bg-red-100 text-red-800'
          }`}>
            {sessionStatus === "CONNECTED" ? "已連接" : 
             sessionStatus === "CONNECTING" ? "連接中..." : "未連接"}
          </div>
          
          {}
          {sessionStatus === "CONNECTED" && (
            <button
              onClick={stopSession}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors font-medium"
            >
              斷線
            </button>
          )}
        </div>
      </div>

      {}
      {sessionStatus === "CONNECTED" && (
        <div className={`px-4 py-2 text-sm border-b ${
          isPTTActive 
            ? 'bg-blue-50 text-blue-700 border-blue-200' 
            : 'bg-green-50 text-green-700 border-green-200'
        }`}>
          {isPTTActive 
            ? "🎙️ 按住說話模式：按住下方的「說話」按鈕來對話" 
            : "🔊 持續對話模式：直接說話，停止說話後系統會自動回應"}
        </div>
      )}

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

export default App;*/

//0530 Testing RTC layout imporve

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 簡化的連接函數
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      pc.addTrack(ms.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData = JSON.parse(e.data);
        handleServerEventRef.current(eventData);
        
        // 檢測語音輸入狀態
        if (eventData.type === "input_audio_buffer.speech_started") {
          setIsListening(true);
        } else if (eventData.type === "input_audio_buffer.speech_stopped" || 
                   eventData.type === "input_audio_buffer.committed") {
          setIsListening(false);
        }
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 從 localStorage 讀取之前保存的模式，默認為 VAD 模式
    const storedMode = localStorage.getItem("conversationMode");
    if (storedMode) {
      setIsPTTActive(storedMode === "PTT");
    } else {
      setIsPTTActive(false); // 默認使用 VAD 模式（持續對話）
      localStorage.setItem("conversationMode", "VAD");
    }
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            AI營養師
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={toggleConversationMode}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md' 
                : isListening
                ? 'bg-green-500 text-white shadow-md animate-pulse'
                : 'bg-green-500 text-white hover:bg-green-600 shadow-md'
            }`}
            title={isPTTActive ? "點擊切換到持續對話模式" : "點擊切換到按住說話模式"}
          >
            {}
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            {}
            {!isPTTActive && isListening && (
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-ping"></div>
            )}
          </button>
        </div>
      </div>

      {}
      {sessionStatus === "CONNECTED" && (
        <div className={`px-4 py-2 text-sm border-b ${
          isPTTActive 
            ? 'bg-blue-50 text-blue-700 border-blue-200' 
            : 'bg-green-50 text-green-700 border-green-200'
        }`}>
          {isPTTActive 
            ? "🎙️ 按住說話模式：按住下方的「說話」按鈕來對話" 
            : isListening
            ? "🎙️ 正在收聽您的語音..."
            : "🔊 持續對話模式：直接說話，停止說話後系統會自動回應"}
        </div>
      )}

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

export default App;*/

//0530 Testing V2 improve layout

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 簡化的連接函數
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      pc.addTrack(ms.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData = JSON.parse(e.data);
        handleServerEventRef.current(eventData);
        
        // 檢測語音輸入狀態
        if (eventData.type === "input_audio_buffer.speech_started") {
          setIsListening(true);
        } else if (eventData.type === "input_audio_buffer.speech_stopped" || 
                   eventData.type === "input_audio_buffer.committed") {
          setIsListening(false);
        }
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 從 localStorage 讀取之前保存的模式，默認為 VAD 模式
    const storedMode = localStorage.getItem("conversationMode");
    if (storedMode) {
      setIsPTTActive(storedMode === "PTT");
    } else {
      setIsPTTActive(false); // 默認使用 VAD 模式（持續對話）
      localStorage.setItem("conversationMode", "VAD");
    }
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            AI 智選藥妝
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={toggleConversationMode}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md' 
                : isListening
                ? 'bg-green-500 text-white shadow-md animate-pulse'
                : 'bg-gray-500 text-white hover:bg-gray-600 shadow-md'
            }`}
            title={isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            {}
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            {}
            {!isPTTActive && isListening && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>



      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          //placeholderText="請輸入文字"
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

export default App;*/

// 0530 Testing V3 improve the micorphone icon applause

/*"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

function App() {
  const searchParams = useSearchParams();

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 簡化的連接函數
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      pc.addTrack(ms.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData = JSON.parse(e.data);
        handleServerEventRef.current(eventData);
        
        // 檢測語音輸入狀態
        if (eventData.type === "input_audio_buffer.speech_started") {
          setIsListening(true);
        } else if (eventData.type === "input_audio_buffer.speech_stopped" || 
                   eventData.type === "input_audio_buffer.committed") {
          setIsListening(false);
        }
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 從 localStorage 讀取之前保存的模式，默認為 VAD 模式
    const storedMode = localStorage.getItem("conversationMode");
    if (storedMode) {
      setIsPTTActive(storedMode === "PTT");
    } else {
      setIsPTTActive(false); // 默認使用 VAD 模式（持續對話）
      localStorage.setItem("conversationMode", "VAD");
    }
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            AI 智選藥妝
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={toggleConversationMode}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative animate-pulse ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md' 
                : 'bg-green-500 text-white hover:bg-green-600 shadow-md'
            }`}
            title={isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            {}
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            {}
            {!isPTTActive && isListening && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>



      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          //placeholderText="請輸入文字"
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

export default App;*/

//0530 Testing V4 customize pop up window 

// Stop current session, clean up peer connection and data channel
/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

// Separate the main app logic into a component that uses search params
function AppContent() {
  const searchParams = useSearchParams();

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(true);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [showMicPermissionModal, setShowMicPermissionModal] = useState<boolean>(false);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 請求麥克風權限的函數
  const requestMicrophonePermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 獲得權限後關閉流，實際使用時會重新獲取
      stream.getTracks().forEach(track => track.stop());
      return stream;
    } catch (err) {
      console.error("麥克風權限被拒絕:", err);
      throw err;
    }
  };

  // 簡化的連接函數
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    
    // 檢查是否需要顯示權限說明彈窗
    try {
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permissionStatus.state === 'prompt') {
        setShowMicPermissionModal(true);
        return;
      }
    } catch (err) {
      // 如果不支持 permissions API，直接顯示彈窗
      console.log("Permissions API not supported:", err);
      setShowMicPermissionModal(true);
      return;
    }

    // 如果已經有權限，直接開始連接
    await connectToRealtime();
  }
  // 實際連接到 Realtime API 的函數
  async function connectToRealtime() {
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      await requestMicrophonePermission();
      const newMs = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(newMs.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData = JSON.parse(e.data);
        handleServerEventRef.current(eventData);
        
        // 檢測語音輸入狀態
        if (eventData.type === "input_audio_buffer.speech_started") {
          setIsListening(true);
        } else if (eventData.type === "input_audio_buffer.speech_stopped" || 
                   eventData.type === "input_audio_buffer.committed") {
          setIsListening(false);
        }
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  // 處理用戶同意權限請求
  const handleMicPermissionAccept = async () => {
    setShowMicPermissionModal(false);
    await connectToRealtime();
  };

  // 處理用戶拒絕權限請求
  const handleMicPermissionDecline = () => {
    setShowMicPermissionModal(false);
    // 可以在這裡添加提示用戶手動開啟權限的說明
  };
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 從 localStorage 讀取之前保存的模式，默認為 VAD 模式
    const storedMode = localStorage.getItem("conversationMode");
    if (storedMode) {
      setIsPTTActive(storedMode === "PTT");
    } else {
      setIsPTTActive(false); // 默認使用 VAD 模式（持續對話）
      localStorage.setItem("conversationMode", "VAD");
    }
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      
      {}
      {showMicPermissionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-2xl">
            <div className="text-center">
              {}
              <div className="mx-auto w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
                <svg 
                  width="32" 
                  height="32" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="#3B82F6" 
                  strokeWidth="2"
                >
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                </svg>
              </div>
              
              {}
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                麥克風權限請求
              </h2>
              
              {}
              <p className="text-gray-600 mb-6 leading-relaxed">
                <strong>AI 智選藥妝</strong> 需要使用您的麥克風來提供語音對話功能。
                <br /><br />
                這將讓您能夠：
                <br />• 透過語音與 AI 營養師對話
                <br />• 獲得即時的營養建議和產品推薦
                <br />• 享受更自然的互動體驗
              </p>
              
              {}
              <div className="flex gap-3 justify-center">
                <button
                  onClick={handleMicPermissionDecline}
                  className="px-4 py-2 text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  稍後再說
                </button>
                <button
                  onClick={handleMicPermissionAccept}
                  className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium"
                >
                  允許使用
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            AI營養師
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={toggleConversationMode}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative animate-pulse ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md' 
                : 'bg-green-500 text-white hover:bg-green-600 shadow-md'
            }`}
            title={isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            {}
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            {}
            {!isPTTActive && isListening && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

// Main App component with Suspense wrapper
function App() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg">載入中...</div>
      </div>
    }>
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0530 Testing V5 

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

// Separate the main app logic into a component that uses search params
function AppContent() {
  const searchParams = useSearchParams();

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  // 修改: 預設為 false (VAD模式 - 持續聆聽)
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [showMicPermissionModal, setShowMicPermissionModal] = useState<boolean>(false);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 請求麥克風權限的函數
  const requestMicrophonePermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 獲得權限後關閉流，實際使用時會重新獲取
      stream.getTracks().forEach(track => track.stop());
      return stream;
    } catch (err) {
      console.error("麥克風權限被拒絕:", err);
      throw err;
    }
  };

  // 簡化的連接函數
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    
    // 檢查是否需要顯示權限說明彈窗
    try {
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permissionStatus.state === 'prompt') {
        setShowMicPermissionModal(true);
        return;
      }
    } catch (err) {
      // 如果不支持 permissions API，直接顯示彈窗
      console.log("Permissions API not supported:", err);
      setShowMicPermissionModal(true);
      return;
    }

    // 如果已經有權限，直接開始連接
    await connectToRealtime();
  }
  // 實際連接到 Realtime API 的函數
  async function connectToRealtime() {
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      await requestMicrophonePermission();
      const newMs = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(newMs.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData = JSON.parse(e.data);
        handleServerEventRef.current(eventData);
        
        // 檢測語音輸入狀態
        if (eventData.type === "input_audio_buffer.speech_started") {
          setIsListening(true);
        } else if (eventData.type === "input_audio_buffer.speech_stopped" || 
                   eventData.type === "input_audio_buffer.committed") {
          setIsListening(false);
        }
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  // 處理用戶同意權限請求
  const handleMicPermissionAccept = async () => {
    setShowMicPermissionModal(false);
    await connectToRealtime();
  };

  // 處理用戶拒絕權限請求
  const handleMicPermissionDecline = () => {
    setShowMicPermissionModal(false);
    // 可以在這裡添加提示用戶手動開啟權限的說明
  };
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage (修改: 不再自動從 localStorage 讀取，始終預設為 VAD)
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 修改: 移除從 localStorage 讀取的邏輯，始終預設為 VAD 模式
    // 如果想要保持用戶的選擇，可以保留 localStorage 邏輯
    // 但根據您的需求，這裡直接設置為 VAD 模式
    setIsPTTActive(false); // 始終預設為 VAD 模式（持續對話）
    localStorage.setItem("conversationMode", "VAD");
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      
      {}
      {showMicPermissionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-2xl">
            <div className="text-center">
              {}
              <div className="mx-auto w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
                <svg 
                  width="32" 
                  height="32" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="#3B82F6" 
                  strokeWidth="2"
                >
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                </svg>
              </div>
              
              {}
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                麥克風權限請求
              </h2>
              
              {}
              <p className="text-gray-600 mb-6 leading-relaxed">
                <strong>AI 智選藥妝</strong> 需要使用您的麥克風來提供語音對話功能。
                <br /><br />
                這將讓您能夠：
                <br />• 透過語音與 AI 營養師對話
                <br />• 獲得即時的營養建議和產品推薦
                <br />• 享受更自然的互動體驗
              </p>
              
              {}
              <div className="flex gap-3 justify-center">
                <button
                  onClick={handleMicPermissionDecline}
                  className="px-4 py-2 text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  稍後再說
                </button>
                <button
                  onClick={handleMicPermissionAccept}
                  className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium"
                >
                  允許使用
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            AI 智選藥妝
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={toggleConversationMode}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative animate-pulse ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md' 
                : 'bg-green-500 text-white hover:bg-green-600 shadow-md'
            }`}
            title={isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            {}
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            {}
            {!isPTTActive && isListening && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

// Main App component with Suspense wrapper
function App() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg">載入中...</div>
      </div>
    }>
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0530 Testing V6

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

// Separate the main app logic into a component that uses search params
function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // URL 參數管理函數
  function setSearchParam(key: string, value: string) {
    // 先把現有參數讀進來
    const params = new URLSearchParams(searchParams.toString());
    // 設定/更新你想要的參數
    params.set(key, value);
    // 用 router 替換網址，不會跳頁（不刷新）
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems, addTranscriptMessage, addTranscriptBreadcrumb } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  // 修改: 預設為 false (VAD模式 - 持續聆聽)
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [showMicPermissionModal, setShowMicPermissionModal] = useState<boolean>(false);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
      updateSession(true);
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 請求麥克風權限的函數
  const requestMicrophonePermission = async () => {
    try {
      // 在 Safari 中，這個 getUserMedia 呼叫會觸發系統的權限對話框
      // 對話框會顯示 "AI智選藥妝" 想要使用您的麥克風
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          // 可以加入更多音訊設定來優化體驗
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      // 獲得權限後關閉流，實際使用時會重新獲取
      stream.getTracks().forEach(track => track.stop());
      return stream;
    } catch (err) {
      console.error("麥克風權限被拒絕:", err);
      throw err;
    }
  };

  // 簡化的連接函數
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    
    // 檢查是否需要顯示權限說明彈窗
    try {
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permissionStatus.state === 'prompt') {
        setShowMicPermissionModal(true);
        return;
      }
    } catch (err) {
      // 如果不支持 permissions API，直接顯示彈窗
      console.log("Permissions API not supported:", err);
      setShowMicPermissionModal(true);
      return;
    }

    // 如果已經有權限，直接開始連接
    await connectToRealtime();
  }
  // 實際連接到 Realtime API 的函數
  async function connectToRealtime() {
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      await requestMicrophonePermission();
      const newMs = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      pc.addTrack(newMs.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData = JSON.parse(e.data);
        handleServerEventRef.current(eventData);
        
        // 檢測語音輸入狀態
        if (eventData.type === "input_audio_buffer.speech_started") {
          setIsListening(true);
        } else if (eventData.type === "input_audio_buffer.speech_stopped" || 
                   eventData.type === "input_audio_buffer.committed") {
          setIsListening(false);
        }
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  // 處理用戶同意權限請求
  const handleMicPermissionAccept = async () => {
    setShowMicPermissionModal(false);
    await connectToRealtime();
  };

  // 處理用戶拒絕權限請求
  const handleMicPermissionDecline = () => {
    setShowMicPermissionModal(false);
    // 可以在這裡添加提示用戶手動開啟權限的說明
  };
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage("您好，很高興為您服務！");
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage (修改: 不再自動從 localStorage 讀取，始終預設為 VAD)
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 修改: 移除從 localStorage 讀取的邏輯，始終預設為 VAD 模式
    // 如果想要保持用戶的選擇，可以保留 localStorage 邏輯
    // 但根據您的需求，這裡直接設置為 VAD 模式
    setIsPTTActive(false); // 始終預設為 VAD 模式（持續對話）
    localStorage.setItem("conversationMode", "VAD");
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      
      {}
{showMicPermissionModal && (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-2xl">
      <div className="text-center">
        {}
        <div className="mx-auto w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
          <svg 
            width="32" 
            height="32" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="#3B82F6" 
            strokeWidth="2"
          >
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        </div>
        
        {}
        <h2 className="text-xl font-bold text-gray-900 mb-6">
          麥克風權限請求
        </h2>
        
        {}
        <div className="flex gap-3 justify-center">
          <button
            onClick={handleMicPermissionDecline}
            className="px-4 py-2 text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            不允許
          </button>
          <button
            onClick={handleMicPermissionAccept}
            className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium"
          >
            允許
          </button>
        </div>
      </div>
    </div>
  </div>
)}
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            AI 營養師
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={toggleConversationMode}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative animate-pulse ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md' 
                : 'bg-green-500 text-white hover:bg-green-600 shadow-md'
            }`}
            title={isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            {}
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            {}
            {!isPTTActive && isListening && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

// Main App component with Suspense wrapper
function App() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg">載入中...</div>
      </div>
    }>
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0602 Testing ----> final version checkpoint

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

// Separate the main app logic into a component that uses search params
function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // URL 參數管理函數
  function setSearchParam(key: string, value: string) {
    // 先把現有參數讀進來
    const params = new URLSearchParams(searchParams.toString());
    // 設定/更新你想要的參數
    params.set(key, value);
    // 用 router 替換網址，不會跳頁（不刷新）
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  // 修改: 預設為 false (VAD模式 - 持續聆聽)
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      // 移除顯示 Agent breadcrumb，直接更新 session
      updateSession(); // 更新 session
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 簡化的連接函數 - 移除權限彈窗
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  // 實際連接到 Realtime API 的函數
  async function connectToRealtime() {
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      const newMs = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      pc.addTrack(newMs.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData = JSON.parse(e.data);
        handleServerEventRef.current(eventData);
        
        // 檢測語音輸入狀態
        if (eventData.type === "input_audio_buffer.speech_started") {
          setIsListening(true);
        } else if (eventData.type === "input_audio_buffer.speech_stopped" || 
                   eventData.type === "input_audio_buffer.committed") {
          setIsListening(false);
        }
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const updateSession = () => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 處理麥克風按鈕點擊 - 新增打斷功能
  const handleMicrophoneClick = () => {
    // 如果 ChatGPT 正在講話，打斷它並開始收聽
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      // 打斷後如果是 VAD 模式，會自動開始收聽
      // 如果是 PTT 模式，用戶需要按住說話按鈕
      return;
    }
    
    // 否則切換對話模式
    toggleConversationMode();
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 修改: 移除從 localStorage 讀取的邏輯，始終預設為 VAD 模式
    setIsPTTActive(false); // 始終預設為 VAD 模式（持續對話）
    localStorage.setItem("conversationMode", "VAD");
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            AI 營養師
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse' 
                : 'bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse'
            }`}
            title={
              isOutputAudioBufferActive 
                ? "點擊打斷 AI 講話" 
                : isPTTActive 
                  ? "點擊切換到持續對話模式" 
                  : "持續對話模式"
            }
          >
            {}
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            {}
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

// Main App component with Suspense wrapper
function App() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg">載入中...</div>
      </div>
    }>
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0602 Testing remove session.id, start at: --> in hooks/useHandleServerEvent.ts

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";

// Types
import { AgentConfig, SessionStatus } from "@/app/types";

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Agent configs
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";

import useAudioDownload from "./hooks/useAudioDownload";

// Separate the main app logic into a component that uses search params
function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // URL 參數管理函數
  function setSearchParam(key: string, value: string) {
    // 先把現有參數讀進來
    const params = new URLSearchParams(searchParams.toString());
    // 設定/更新你想要的參數
    params.set(key, value);
    // 用 router 替換網址，不會跳頁（不刷新）
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    AgentConfig[] | null
  >(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = 
    useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  // 修改: 預設為 false (VAD模式 - 持續聆聽)
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);

  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] =
    useState<boolean>(false);

  // Initialize the recording hook.
  const { startRecording, stopRecording, downloadRecording } =
    useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      // 移除顯示 Agent breadcrumb，直接更新 session
      updateSession(); // 更新 session
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      console.log(
        `updatingSession, isPTTActive=${isPTTActive} sessionStatus=${sessionStatus}`
      );
      updateSession();
    }
  }, [isPTTActive]);

  // 簡化的連接函數 - 移除權限彈窗
  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  // 實際連接到 Realtime API 的函數
  async function connectToRealtime() {
    setSessionStatus("CONNECTING");

    try {
      // Get a session token for OpenAI Realtime API
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) {
          audioElement.current.srcObject = e.streams[0];
        }
      };

      // Add local audio track for microphone input in the browser
      const newMs = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      pc.addTrack(newMs.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Data channel event listeners
      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData = JSON.parse(e.data);
        handleServerEventRef.current(eventData);
        
        // 檢測語音輸入狀態
        if (eventData.type === "input_audio_buffer.speech_started") {
          setIsListening(true);
        } else if (eventData.type === "input_audio_buffer.speech_stopped" || 
                   eventData.type === "input_audio_buffer.committed") {
          setIsListening(false);
        }
      });

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      await pc.setRemoteDescription({
        type: "answer" as RTCSdpType,
        sdp: await sdpResponse.text(),
      });

    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const updateSession = () => {
    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,  // 降低閾值，讓語音檢測更敏感
          prefix_padding_ms: 300,
          silence_duration_ms: 800,  // 增加靜音時間，避免太快觸發
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent(
        { type: "response.cancel" },
        "(cancel due to user interruption)"
      );
    }

    if (isOutputAudioBufferActive) {
      sendClientEvent(
        { type: "output_audio_buffer.clear" },
        "(cancel due to user interruption)"
      );
    }
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open")
      return;
    cancelAssistantSpeech();

    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (
      sessionStatus !== "CONNECTED" ||
      dataChannel?.readyState !== "open" ||
      !isPTTUserSpeaking
    )
      return;

    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  // 處理麥克風按鈕點擊 - 新增打斷功能
  const handleMicrophoneClick = () => {
    // 如果 ChatGPT 正在講話，打斷它並開始收聽
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      // 打斷後如果是 VAD 模式，會自動開始收聽
      // 如果是 PTT 模式，用戶需要按住說話按鈕
      return;
    }
    
    // 否則切換對話模式
    toggleConversationMode();
  };

  // 切換 PTT 和 VAD 模式的函數
  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    
    // 保存到 localStorage
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    
    console.log(`切換到${newMode ? 'PTT' : 'VAD'}模式`);
  };

  useEffect(() => {
    // 修改: 移除從 localStorage 讀取的邏輯，始終預設為 VAD 模式
    setIsPTTActive(false); // 始終預設為 VAD 模式（持續對話）
    localStorage.setItem("conversationMode", "VAD");
    
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    } else {
      localStorage.setItem("logsExpanded", "false");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" 
         style={{ 
           height: '100dvh',
           maxHeight: '100dvh'
         }}>
      
      {}
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/Weider_logo_1.png"
              alt="Weider Logo"
              width={40}
              height={40}
              className="mr-2"
            />
          </div>
          <div>
            AI 營養師
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {}
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive 
                ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse' 
                : 'bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse'
            }`}
            title={
              isOutputAudioBufferActive 
                ? "點擊打斷 AI 講話" 
                : isPTTActive 
                  ? "點擊切換到持續對話模式" 
                  : "持續對話模式"
            }
          >
            {}
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            {}
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      {}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={
            sessionStatus === "CONNECTED" &&
            dataChannel?.readyState === "open"
          }
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />

        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

// Main App component with Suspense wrapper
function App() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg">載入中...</div>
      </div>
    }>
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0811 GPT-5 Add log to report/daily

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // === 問答寫入 Blob 用的狀態 ===
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const assistantBufferRef = useRef<string>("");

  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!userId || !sessionId) return;
    const body = JSON.stringify({ ...log, userId, sessionId });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/logs", new Blob([body], { type: "application/json" }));
      } else {
        await fetch("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      }
    } catch (e) {
      console.warn("postLog failed", e);
    }
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 拿 Realtime ephemeral key + 我們自己的 userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) setUserId(data.userId);
      if (data?.sessionId) setSessionId(data.sessionId);

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★ 這裡：更穩健的 Realtime 事件彙整，確保能寫到 assistant 回覆
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        // 語音輸入狀態
        const t = String(eventData?.type || "");
        if (t === "input_audio_buffer.speech_started") setIsListening(true);
        if (t === "input_audio_buffer.speech_stopped" || t === "input_audio_buffer.committed") setIsListening(false);

        // 助手輸出中的文字（多版本事件名相容）
        if (
          t === "response.output_text.delta" ||
          t === "output_text.delta" ||
          t.startsWith("response.refusal.delta")
        ) {
          assistantBufferRef.current += eventData.delta || "";
        }

        // 助手完成 → 寫入一筆完整回答（相容多事件名）
        if (t === "response.completed" || t === "response.output_text.done" || t === "output_text.done") {
          const full = assistantBufferRef.current.trim();
          if (full) {
            postLog({ role: "assistant", content: full, eventId: eventData.response?.id || eventData.id });
          }
          assistantBufferRef.current = "";
        }

        // （選）語音轉文字完成 → 記錄成使用者訊息
        if (t.includes("input_audio_transcription") && t.includes("completed")) {
          const text = eventData.transcript || eventData.text || "";
          if (text) postLog({ role: "user", content: text, eventId: eventData.item_id });
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 寫入一筆使用者訊息
    postLog({ role: "user", content: textToSend });

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 營養師</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0811 gpt log user question assist answer V1

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 混合式落檔：必要狀態 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const assistantBufferRef = useRef<string>("");
  const loggedIds = useRef<Set<string>>(new Set());

  function extractTextFromContent(content: any): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) =>
          typeof c === "string"
            ? c
            : c?.text ?? c?.value ?? (typeof c?.content === "string" ? c.content : "")
        )
        .join(" ")
        .trim();
    }
    if (typeof content === "object") {
      if (typeof content.text === "string") return content.text;
      if (typeof content.value === "string") return content.value;
      if (typeof content.content === "string") return content.content;
    }
    return "";
  }
  
  // 0811 V2 add assist answer
  function extractAssistantTextFromResponse(ev: any): string {
  const r = ev?.response || ev;
  // 直接欄位
  if (typeof r?.output_text === "string") return r.output_text;
  if (Array.isArray(r?.output_text)) return r.output_text.join("");

  // 內容陣列常見寫法
  if (Array.isArray(r?.content)) {
    const txt = r.content
      .map((c: any) => {
        if (typeof c?.text === "string") return c.text;
        if (typeof c?.value === "string") return c.value;
        if (typeof c?.content === "string") return c.content;
        if (c?.type && typeof c?.text === "string") return c.text; // e.g. {type:'output_text', text:'...'}
        return "";
      })
      .filter(Boolean)
      .join("")
      .trim();
    if (txt) return txt;
  }

  // 其他保底欄位
  if (typeof r?.text === "string") return r.text;
  if (typeof ev?.text === "string") return ev.text;
  return "";
}
  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!userId || !sessionId || !log.content?.trim()) return;
    const body = JSON.stringify({ ...log, userId, sessionId });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/logs", new Blob([body], { type: "application/json" }));
      } else {
        await fetch("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      }
    } catch (e) {
      console.warn("postLog failed", e);
    }
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 取 ephemeral key + 我們自己的 userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) setUserId(data.userId);
      if (data?.sessionId) setSessionId(data.sessionId);

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★ 保險：在 DC 事件層做助理回覆落檔（無論 Transcript 狀態如何）
      dc.addEventListener("message", (e: MessageEvent) => {
  const eventData: any = JSON.parse(e.data);
  handleServerEventRef.current(eventData);

  const t = String(eventData?.type || "");

  // 麥克風聆聽指示燈
  if (t === "input_audio_buffer.speech_started") setIsListening(true);
  if (t === "input_audio_buffer.speech_stopped" || t === "input_audio_buffer.committed") setIsListening(false);

  // —— 助理輸出：先清空 buffer（開始一個新回合）
  if (t === "response.created" || t === "response.started") {
    assistantBufferRef.current = "";
  }

  // —— 助理輸出：累積 delta（若模型有送文字流）
  if (
    t === "response.output_text.delta" ||
    t === "output_text.delta" ||
    t.startsWith("response.refusal.delta")
  ) {
    assistantBufferRef.current += eventData.delta || "";
  }

  // —— 助理完成：不論有沒有 delta，都嘗試取文字並落檔
  if (t === "response.completed" || t === "response.output_text.done" || t === "output_text.done") {
    // 1) 先用我們累積的
    let full = (assistantBufferRef.current || "").trim();

    // 2) 沒有的話，從 eventData.response 的幾種常見結構兜底取文字
    if (!full) full = extractAssistantTextFromResponse(eventData) || "";

    if (full) {
      postLog({
        role: "assistant",
        content: full,
        eventId: eventData.response?.id || eventData.id,
      });
    }
    assistantBufferRef.current = "";
  }

  // —— 麥克風語音→轉文字完成：記錄為 user 訊息
  // 這裡放寬判斷，避免不同版本事件名稱對不上
  if ((t.includes("transcription") || t.includes("speech.recognized")) && t.includes("completed")) {
    const text = eventData.transcript || eventData.text || "";
    if (text) {
      postLog({ role: "user", content: text, eventId: eventData.item_id });
    }
  }
});

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 文字送出時，先記一筆 user（避免 Transcript/Whisper 延遲漏記）
    const id = `user:${textToSend}`;
    if (!loggedIds.current.has(id)) {
      postLog({ role: "user", content: textToSend });
      loggedIds.current.add(id);
    }

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  // 保底：從 Transcript 監測完成訊息（避免 UI pipeline 改動）
  useEffect(() => {
    if (!transcriptItems?.length) return;

    for (const item of transcriptItems as any[]) {
      const roleStr = String(item.role);
      if (roleStr !== "user" && roleStr !== "assistant") continue;

      const text = extractTextFromContent(item.content);
      if (!text) continue;

      const id =
        item.id ||
        item.item_id ||
        `${roleStr}:${text}`;

      if (!id || loggedIds.current.has(id)) continue;

      const status = String(item.status || item.state || "").toUpperCase();
      const isDone = status.includes("COMPLETE") || status.includes("FINAL") || status === "";

      if (!isDone) continue;

      postLog({ role: roleStr as "user" | "assistant", content: text, eventId: item.id || item.item_id });
      loggedIds.current.add(id);
    }
  }, [transcriptItems]);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 營養師</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0812 claude.ai try fix the microphone and assist answer problem

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 混合式落檔：必要狀態 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const assistantBufferRef = useRef<string>("");
  const loggedIds = useRef<Set<string>>(new Set());
  const currentResponseIdRef = useRef<string | null>(null);

  function extractTextFromContent(content: any): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) =>
          typeof c === "string"
            ? c
            : c?.text ?? c?.value ?? (typeof c?.content === "string" ? c.content : "")
        )
        .join(" ")
        .trim();
    }
    if (typeof content === "object") {
      if (typeof content.text === "string") return content.text;
      if (typeof content.value === "string") return content.value;
      if (typeof content.content === "string") return content.content;
    }
    return "";
  }
  
  // 改進：更強健的助理回覆文字提取
  function extractAssistantTextFromResponse(ev: any): string {
    const r = ev?.response || ev;
    
    // 檢查常見的文字欄位
    if (typeof r?.output_text === "string" && r.output_text.trim()) return r.output_text.trim();
    if (Array.isArray(r?.output_text)) return r.output_text.join("").trim();

    // 檢查內容陣列
    if (Array.isArray(r?.content)) {
      const txt = r.content
        .map((c: any) => {
          if (typeof c?.text === "string") return c.text;
          if (typeof c?.value === "string") return c.value;
          if (typeof c?.content === "string") return c.content;
          if (c?.type === "text" && typeof c?.text === "string") return c.text;
          return "";
        })
        .filter(Boolean)
        .join("")
        .trim();
      if (txt) return txt;
    }

    // 檢查其他可能的欄位
    if (typeof r?.text === "string" && r.text.trim()) return r.text.trim();
    if (typeof ev?.text === "string" && ev.text.trim()) return ev.text.trim();
    if (typeof r?.transcript === "string" && r.transcript.trim()) return r.transcript.trim();
    
    return "";
  }

  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!userId || !sessionId || !log.content?.trim()) {
      console.warn("postLog skipped:", { userId, sessionId, hasContent: !!log.content?.trim() });
      return;
    }
    
    const body = JSON.stringify({ ...log, userId, sessionId });
    console.log("Posting log:", { role: log.role, content: log.content.substring(0, 100) + "...", eventId: log.eventId });
    
    try {
      if (navigator.sendBeacon) {
        const success = navigator.sendBeacon("/api/logs", new Blob([body], { type: "application/json" }));
        if (!success) {
          // sendBeacon 失敗時回退到 fetch
          await fetch("/api/logs", { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body 
          });
        }
      } else {
        const response = await fetch("/api/logs", { 
          method: "POST", 
          headers: { "Content-Type": "application/json" }, 
          body 
        });
        if (!response.ok) {
          console.error("Log API responded with error:", response.status, response.statusText);
        }
      }
    } catch (e) {
      console.error("postLog failed:", e);
    }
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 取 ephemeral key + 我們自己的 userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) setUserId(data.userId);
      if (data?.sessionId) setSessionId(data.sessionId);

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★ 改進的事件處理：更詳細的日誌和更強健的文字提取
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("Received event:", eventType, eventData);

        // 麥克風聆聽指示燈
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("User started speaking");
        }
        if (eventType === "input_audio_buffer.speech_stopped" || eventType === "input_audio_buffer.committed") {
          setIsListening(false);
          console.log("User stopped speaking");
        }

        // —— 處理語音轉文字完成事件 ——
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const transcript = eventData.transcript || eventData.text || "";
          console.log("Speech transcription completed:", transcript);
          if (transcript.trim()) {
            const eventId = eventData.item_id || eventData.id || `speech_${Date.now()}`;
            postLog({ 
              role: "user", 
              content: transcript.trim(), 
              eventId 
            });
          }
        }

        // —— 助理回覆開始：重置 buffer ——
        if (eventType === "response.created") {
          currentResponseIdRef.current = eventData.response?.id || eventData.id;
          assistantBufferRef.current = "";
          console.log("Assistant response started:", currentResponseIdRef.current);
        }

        // —— 累積助理回覆的文字片段 ——
        if (eventType === "response.content_part.added") {
          const part = eventData.part;
          if (part?.type === "text") {
            console.log("Text part added to response");
          }
        }

        if (eventType === "response.text.delta") {
          const delta = eventData.delta || "";
          assistantBufferRef.current += delta;
          console.log("Assistant text delta:", delta);
        }

        // —— 助理回覆完成：記錄完整回覆 ——
        if (eventType === "response.done") {
          console.log("Assistant response completed");
          
          // 1. 優先使用累積的 delta
          let assistantText = assistantBufferRef.current.trim();
          
          // 2. 如果沒有 delta，嘗試從 response 物件提取
          if (!assistantText) {
            assistantText = extractAssistantTextFromResponse(eventData);
          }
          
          // 3. 如果還是沒有，檢查 response 中的 output
          if (!assistantText && eventData.response?.output) {
            const outputs = Array.isArray(eventData.response.output) 
              ? eventData.response.output 
              : [eventData.response.output];
            
            for (const output of outputs) {
              if (output?.type === "text" && output.text) {
                assistantText += output.text;
              } else if (output?.content) {
                const contentText = extractTextFromContent(output.content);
                if (contentText) assistantText += contentText;
              }
            }
            assistantText = assistantText.trim();
          }

          console.log("Final assistant text:", assistantText);
          
          if (assistantText) {
            postLog({
              role: "assistant",
              content: assistantText,
              eventId: currentResponseIdRef.current || eventData.response?.id || eventData.id,
            });
          } else {
            console.warn("No assistant text found in response:", eventData);
          }
          
          // 重置狀態
          assistantBufferRef.current = "";
          currentResponseIdRef.current = null;
        }

        // —— 備用：處理其他可能的完成事件 ——
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          if (part?.type === "text" && part.text && part.text.trim()) {
            console.log("Content part done with text:", part.text);
            // 這裡我們不直接記錄，等 response.done 統一處理
            if (!assistantBufferRef.current.includes(part.text)) {
              assistantBufferRef.current += part.text;
            }
          }
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;
    
    console.log("Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 文字送出時，立即記錄 user 訊息
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    postLog({ role: "user", content: textToSend, eventId });

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  // 保底：從 Transcript 監測完成訊息（避免 UI pipeline 改動造成遺漏）
  useEffect(() => {
    if (!transcriptItems?.length) return;

    for (const item of transcriptItems as any[]) {
      const roleStr = String(item.role);
      if (roleStr !== "user" && roleStr !== "assistant") continue;

      const text = extractTextFromContent(item.content);
      if (!text) continue;

      const id = item.id || item.item_id || `${roleStr}:${text.substring(0, 50)}`;

      if (!id || loggedIds.current.has(id)) continue;

      const status = String(item.status || item.state || "").toUpperCase();
      const isDone = status.includes("COMPLETE") || status.includes("FINAL") || status === "" || status === "COMPLETED";

      if (!isDone) continue;

      console.log("Backup logging from transcript:", { role: roleStr, text: text.substring(0, 100) + "..." });
      postLog({ role: roleStr as "user" | "assistant", content: text, eventId: item.id || item.item_id });
      loggedIds.current.add(id);
    }
  }, [transcriptItems]);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 營養師</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0814 V1 try to fixing the assist reply log

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 改进的日志记录状态管理 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  
  // 用于累积助手回应的状态
  const assistantResponseBuffer = useRef<{
    responseId: string | null;
    itemId: string | null;
    textBuffer: string;
    isCollecting: boolean;
  }>({
    responseId: null,
    itemId: null,
    textBuffer: "",
    isCollecting: false,
  });

  // 防止重复记录的 Set
  const loggedEventIds = useRef<Set<string>>(new Set());

  function extractTextFromContent(content: any): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) =>
          typeof c === "string"
            ? c
            : c?.text ?? c?.value ?? (typeof c?.content === "string" ? c.content : "")
        )
        .join(" ")
        .trim();
    }
    if (typeof content === "object") {
      if (typeof content.text === "string") return content.text;
      if (typeof content.value === "string") return content.value;
      if (typeof content.content === "string") return content.content;
    }
    return "";
  }

  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!userId || !sessionId || !log.content?.trim()) {
      console.warn("postLog skipped:", { userId, sessionId, hasContent: !!log.content?.trim() });
      return;
    }

    // 防止重复记录
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);
    
    const body = JSON.stringify({ ...log, userId, sessionId, eventId });
    console.log("📝 Posting log:", { 
      role: log.role, 
      content: log.content.substring(0, 100) + (log.content.length > 100 ? "..." : ""), 
      eventId 
    });
    
    try {
      if (navigator.sendBeacon) {
        const success = navigator.sendBeacon("/api/logs", new Blob([body], { type: "application/json" }));
        if (!success) {
          await fetch("/api/logs", { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body 
          });
        }
      } else {
        const response = await fetch("/api/logs", { 
          method: "POST", 
          headers: { "Content-Type": "application/json" }, 
          body 
        });
        if (!response.ok) {
          console.error("Log API responded with error:", response.status, response.statusText);
        }
      }
    } catch (e) {
      console.error("postLog failed:", e);
    }
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 获取 ephemeral key + userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) setUserId(data.userId);
      if (data?.sessionId) setSessionId(data.sessionId);

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 设置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 改进的事件处理逻辑 ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("🔔 Received event:", eventType, eventData);

        // 处理麦克风状态指示
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("🎤 User started speaking");
        }
        if (eventType === "input_audio_buffer.speech_stopped" || eventType === "input_audio_buffer.committed") {
          setIsListening(false);
          console.log("🎤 User stopped speaking");
        }

        // —— 用户语音转文字完成 ——
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const transcript = eventData.transcript || eventData.text || "";
          console.log("🗣️ Speech transcription completed:", transcript);
          if (transcript.trim()) {
            const eventId = eventData.item_id || eventData.id || `speech_${Date.now()}`;
            postLog({ 
              role: "user", 
              content: transcript.trim(), 
              eventId 
            });
          }
        }

        // —— 助手回应开始：初始化缓冲区 ——
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          console.log("🤖 Assistant response created:", responseId);
          
          assistantResponseBuffer.current = {
            responseId,
            itemId: null,
            textBuffer: "",
            isCollecting: true,
          };
        }

        // —— 内容项创建：记录 item ID ——
        if (eventType === "response.content_part.added") {
          const part = eventData.part;
          const itemId = eventData.item_id;
          
          console.log("📝 Content part added:", { itemId, partType: part?.type });
          
          if (part?.type === "text" && assistantResponseBuffer.current.isCollecting) {
            assistantResponseBuffer.current.itemId = itemId;
          }
        }

        // —— 文字增量更新：累积内容 ——
        if (eventType === "response.text.delta") {
          const delta = eventData.delta || "";
          if (assistantResponseBuffer.current.isCollecting) {
            assistantResponseBuffer.current.textBuffer += delta;
            console.log("📄 Assistant text delta added:", {
              delta: delta.substring(0, 50) + (delta.length > 50 ? "..." : ""),
              totalLength: assistantResponseBuffer.current.textBuffer.length
            });
          }
        }

        // —— 内容部分完成：备用记录点 ——
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          console.log("✅ Content part done:", { partType: part?.type, hasText: !!part?.text });
          
          if (part?.type === "text" && part.text && assistantResponseBuffer.current.isCollecting) {
            // 确保文字被记录到缓冲区
            if (!assistantResponseBuffer.current.textBuffer.includes(part.text)) {
              assistantResponseBuffer.current.textBuffer += part.text;
              console.log("📝 Added missing text from content part done");
            }
          }
        }

        // —— 助手回应完成：记录完整回应 ——
        if (eventType === "response.done") {
          console.log("🏁 Assistant response completed");
          
          const buffer = assistantResponseBuffer.current;
          let finalText = buffer.textBuffer.trim();
          
          // 如果缓冲区为空，尝试从事件数据中提取
          if (!finalText && eventData.response) {
            const response = eventData.response;
            
            // 检查 output 数组
            if (Array.isArray(response.output)) {
              for (const output of response.output) {
                if (output?.content) {
                  const contentText = extractTextFromContent(output.content);
                  if (contentText) {
                    finalText += contentText;
                  }
                }
              }
              finalText = finalText.trim();
            }
            
            // 检查其他可能的字段
            if (!finalText) {
              finalText = extractTextFromContent(response.content) || 
                        response.text || 
                        response.transcript || 
                        "";
            }
          }

          console.log("💾 Final assistant text to log:", {
            length: finalText.length,
            preview: finalText.substring(0, 100) + (finalText.length > 100 ? "..." : ""),
            responseId: buffer.responseId,
            itemId: buffer.itemId
          });
          
          if (finalText) {
            postLog({
              role: "assistant",
              content: finalText,
              eventId: buffer.responseId || buffer.itemId || eventData.response?.id || eventData.id || `assistant_${Date.now()}`,
            });
          } else {
            console.warn("⚠️ No assistant text found in response:", eventData);
          }
          
          // 重置缓冲区
          assistantResponseBuffer.current = {
            responseId: null,
            itemId: null,
            textBuffer: "",
            isCollecting: false,
          };
        }

        // —— 其他可能的完成事件（备用） ——
        if (eventType === "conversation.item.created") {
          const item = eventData.item;
          if (item?.role === "assistant" && item?.content) {
            const text = extractTextFromContent(item.content);
            if (text && text.trim()) {
              console.log("📋 Assistant item created with content:", text.substring(0, 100) + "...");
              // 这里不直接记录，让 response.done 统一处理
            }
          }
        }
      });

      // 创建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);
    
    // 重置日志状态
    assistantResponseBuffer.current = {
      responseId: null,
      itemId: null,
      textBuffer: "",
      isCollecting: false,
    };
    loggedEventIds.current.clear();
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;
    
    console.log("💬 Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 立即记录用户文字消息
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    postLog({ role: "user", content: textToSend, eventId });

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("🎤 PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("🎤 PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打断 ChatGPT 讲话");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切换到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  // 移除了备用的 Transcript 监测逻辑，因为现在主要逻辑已经很完整了

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 营养师</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "点击打断 AI 讲话" : isPTTActive ? "点击切换到持续对话模式" : "持续对话模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">载入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0814 V2 try to fixing the log not assist reply problem

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 改进的日志记录状态管理 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  
  // 用于累积助手回应的状态
  const assistantResponseState = useRef<{
    responseId: string | null;
    itemId: string | null;
    contentPartId: string | null;
    textBuffer: string;
    isActive: boolean;
    startTime: number;
  }>({
    responseId: null,
    itemId: null,
    contentPartId: null,
    textBuffer: "",
    isActive: false,
    startTime: 0,
  });

  // 防止重复记录的 Set
  const loggedEventIds = useRef<Set<string>>(new Set());

  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!userId || !sessionId || !log.content?.trim()) {
      console.warn("🚫 postLog skipped:", { 
        hasUserId: !!userId, 
        hasSessionId: !!sessionId, 
        hasContent: !!log.content?.trim(),
        contentPreview: log.content?.substring(0, 50) + "..."
      });
      return;
    }

    // 防止重复记录
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);
    
    const body = JSON.stringify({ ...log, userId, sessionId, eventId });
    console.log("📝 Posting log:", { 
      role: log.role, 
      content: log.content.substring(0, 100) + (log.content.length > 100 ? "..." : ""), 
      eventId,
      userId: userId.substring(0, 8) + "...",
      sessionId: sessionId.substring(0, 8) + "..."
    });
    
    try {
      if (navigator.sendBeacon) {
        const success = navigator.sendBeacon("/api/logs", new Blob([body], { type: "application/json" }));
        if (!success) {
          console.warn("📡 sendBeacon failed, falling back to fetch");
          const response = await fetch("/api/logs", { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body 
          });
          if (!response.ok) {
            console.error("❌ Log API fetch failed:", response.status, response.statusText);
          } else {
            console.log("✅ Log posted successfully via fetch");
          }
        } else {
          console.log("✅ Log posted successfully via sendBeacon");
        }
      } else {
        const response = await fetch("/api/logs", { 
          method: "POST", 
          headers: { "Content-Type": "application/json" }, 
          body 
        });
        if (!response.ok) {
          console.error("❌ Log API responded with error:", response.status, response.statusText);
        } else {
          console.log("✅ Log posted successfully");
        }
      }
    } catch (e) {
      console.error("💥 postLog failed:", e);
    }
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 获取 ephemeral key + userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 设置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 核心事件处理逻辑 ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        
        // 详细记录所有接收到的事件
        console.log("📨 Event received:", {
          type: eventType,
          data: eventData
        });

        // 处理麦克风状态指示
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("🎤 User started speaking");
        }
        
        if (eventType === "input_audio_buffer.speech_stopped") {
          setIsListening(false);
          console.log("🎤 User stopped speaking");
        }

        if (eventType === "input_audio_buffer.committed") {
          setIsListening(false);
          console.log("🎤 Audio buffer committed");
        }

        // —— 处理用户语音转文字 ——
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const transcript = eventData.transcript || eventData.text || "";
          console.log("🗣️ Speech transcription completed:", transcript);
          
          if (transcript.trim()) {
            const eventId = eventData.item_id || eventData.id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            postLog({ 
              role: "user", 
              content: transcript.trim(), 
              eventId 
            });
          } else {
            console.warn("⚠️ Empty transcript received");
          }
        }

        // —— 处理用户语音转文字失败 ——
        if (eventType === "conversation.item.input_audio_transcription.failed") {
          console.error("❌ Speech transcription failed:", eventData);
        }

        // —— 助手回应开始 ——
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          console.log("🤖 Assistant response created:", responseId);
          
          // 重置并初始化助手回应状态
          assistantResponseState.current = {
            responseId,
            itemId: null,
            contentPartId: null,
            textBuffer: "",
            isActive: true,
            startTime: Date.now(),
          };
        }

        // —— 对话项目创建 ——
        if (eventType === "conversation.item.created") {
          const item = eventData.item;
          const itemId = item?.id || eventData.item_id;
          
          console.log("📋 Conversation item created:", {
            itemId,
            role: item?.role,
            type: item?.type,
            status: item?.status
          });

          // 如果是助手消息项，记录 item ID
          if (item?.role === "assistant" && assistantResponseState.current.isActive) {
            assistantResponseState.current.itemId = itemId;
          }
        }

        // —— 内容部分添加 ——
        if (eventType === "response.content_part.added") {
          const part = eventData.part;
          const itemId = eventData.item_id;
          const partId = part?.id;
          
          console.log("📝 Content part added:", {
            itemId,
            partId,
            partType: part?.type,
            hasText: !!part?.text
          });

          if (part?.type === "text" && assistantResponseState.current.isActive) {
            assistantResponseState.current.itemId = itemId;
            assistantResponseState.current.contentPartId = partId;
            
            // 如果 part 已经有文字，先记录
            if (part.text) {
              assistantResponseState.current.textBuffer += part.text;
              console.log("📄 Initial text from content part:", part.text);
            }
          }
        }

        // —— 文字增量（这是最重要的事件） ——
        if (eventType === "response.text.delta") {
          const delta = eventData.delta || "";
          const itemId = eventData.item_id;
          const contentIndex = eventData.content_index;
          
          console.log("📄 Text delta received:", {
            delta: delta.substring(0, 100) + (delta.length > 100 ? "..." : ""),
            itemId,
            contentIndex,
            deltaLength: delta.length
          });

          if (assistantResponseState.current.isActive) {
            assistantResponseState.current.textBuffer += delta;
            assistantResponseState.current.itemId = itemId || assistantResponseState.current.itemId;
            
            console.log("📊 Current buffer length:", assistantResponseState.current.textBuffer.length);
          } else {
            console.warn("⚠️ Received text delta but assistant response not active");
          }
        }

        // —— 文字完成 ——
        if (eventType === "response.text.done") {
          const text = eventData.text || "";
          const itemId = eventData.item_id;
          
          console.log("✅ Text done:", {
            text: text.substring(0, 100) + (text.length > 100 ? "..." : ""),
            itemId,
            textLength: text.length
          });

          // 确保文字被记录到缓冲区（备用）
          if (text && assistantResponseState.current.isActive) {
            if (!assistantResponseState.current.textBuffer.includes(text)) {
              assistantResponseState.current.textBuffer += text;
              console.log("📝 Added missing text from text.done event");
            }
          }
        }

        // —— 内容部分完成 ——
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          console.log("✅ Content part done:", {
            partType: part?.type,
            hasText: !!part?.text,
            textLength: part?.text?.length || 0
          });

          if (part?.type === "text" && part.text && assistantResponseState.current.isActive) {
            // 确保所有文字都在缓冲区中
            if (!assistantResponseState.current.textBuffer.includes(part.text)) {
              assistantResponseState.current.textBuffer += part.text;
              console.log("📝 Added missing text from content part done");
            }
          }
        }

        // —— 助手回应完成（最终记录点） ——
        if (eventType === "response.done") {
          console.log("🏁 Response done - processing final text");
          
          const state = assistantResponseState.current;
          let finalText = state.textBuffer.trim();
          
          // 如果缓冲区为空，尝试从 response 对象中提取
          if (!finalText && eventData.response) {
            console.log("🔍 Extracting text from response object");
            const response = eventData.response;
            
            // 检查 output 数组
            if (Array.isArray(response.output)) {
              for (const output of response.output) {
                if (output?.content) {
                  const contentArray = Array.isArray(output.content) ? output.content : [output.content];
                  for (const content of contentArray) {
                    if (content?.type === "text" && content.text) {
                      finalText += content.text;
                    }
                  }
                }
              }
            }
          }

          console.log("💾 Final assistant text processing:", {
            bufferLength: state.textBuffer.length,
            finalLength: finalText.length,
            preview: finalText.substring(0, 100) + (finalText.length > 100 ? "..." : ""),
            responseId: state.responseId,
            itemId: state.itemId,
            duration: Date.now() - state.startTime
          });
          
          if (finalText) {
            const eventId = state.responseId || state.itemId || eventData.response?.id || eventData.id || `assistant_${Date.now()}`;
            postLog({
              role: "assistant",
              content: finalText,
              eventId,
            });
          } else {
            console.error("❌ No assistant text found to log:", eventData);
            console.log("🔍 Full response object:", JSON.stringify(eventData.response, null, 2));
          }
          
          // 重置状态
          assistantResponseState.current = {
            responseId: null,
            itemId: null,
            contentPartId: null,
            textBuffer: "",
            isActive: false,
            startTime: 0,
          };
        }

        // —— 错误处理 ——
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
        }

        // —— 调试：记录所有其他事件 ——
        if (!["session.created", "session.updated", "input_audio_buffer.speech_started", 
              "input_audio_buffer.speech_stopped", "input_audio_buffer.committed",
              "conversation.item.input_audio_transcription.completed", "response.created",
              "conversation.item.created", "response.content_part.added", "response.text.delta",
              "response.text.done", "response.content_part.done", "response.done"].includes(eventType)) {
          console.log("🔍 Other event:", eventType, eventData);
        }
      });

      // 创建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });
      
      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);
    
    // 重置日志状态
    assistantResponseState.current = {
      responseId: null,
      itemId: null,
      contentPartId: null,
      textBuffer: "",
      isActive: false,
      startTime: 0,
    };
    loggedEventIds.current.clear();
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;
    
    console.log("💬 Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 立即记录用户文字消息
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    postLog({ role: "user", content: textToSend, eventId });

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("🎤 PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("🎤 PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打断 ChatGPT 讲话");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切换到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 营养师</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "点击打断 AI 讲话" : isPTTActive ? "点击切换到持续对话模式" : "持续对话模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">载入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0815 V1 

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 簡化的助手回應狀態管理 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  
  // 簡化的助手回應狀態
  const assistantResponseState = useRef({
    isActive: false,
    responseId: null as string | null,
    textBuffer: "",
    startTime: 0,
  });

  // 防止重複記錄的 Set
  const loggedEventIds = useRef<Set<string>>(new Set());

  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!userId || !sessionId || !log.content?.trim()) {
      console.warn("🚫 postLog skipped:", { 
        hasUserId: !!userId, 
        hasSessionId: !!sessionId, 
        hasContent: !!log.content?.trim(),
        contentPreview: log.content?.substring(0, 50) + "..."
      });
      return;
    }

    // 防止重複記錄
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);
    
    const body = JSON.stringify({ ...log, userId, sessionId, eventId });
    console.log("📝 Posting log:", { 
      role: log.role, 
      content: log.content.substring(0, 100) + (log.content.length > 100 ? "..." : ""), 
      eventId,
      userId: userId.substring(0, 8) + "...",
      sessionId: sessionId.substring(0, 8) + "..."
    });
    
    try {
      if (navigator.sendBeacon) {
        const success = navigator.sendBeacon("/api/logs", new Blob([body], { type: "application/json" }));
        if (!success) {
          console.warn("📡 sendBeacon failed, falling back to fetch");
          const response = await fetch("/api/logs", { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body 
          });
          if (!response.ok) {
            console.error("❌ Log API fetch failed:", response.status, response.statusText);
          } else {
            console.log("✅ Log posted successfully via fetch");
          }
        } else {
          console.log("✅ Log posted successfully via sendBeacon");
        }
      } else {
        const response = await fetch("/api/logs", { 
          method: "POST", 
          headers: { "Content-Type": "application/json" }, 
          body 
        });
        if (!response.ok) {
          console.error("❌ Log API responded with error:", response.status, response.statusText);
        } else {
          console.log("✅ Log posted successfully");
        }
      }
    } catch (e) {
      console.error("💥 postLog failed:", e);
    }
  }

  // 🛠️ 輔助函數：從 output 數組提取文字
  function extractTextFromOutput(output: any): string {
    let text = "";
    
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item?.type === "text" && item.text) {
          text += item.text;
        } else if (item?.content) {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          for (const contentItem of content) {
            if (contentItem?.type === "text" && contentItem.text) {
              text += contentItem.text;
            }
          }
        }
      }
    }
    
    return text;
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 獲取 ephemeral key + userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 設置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 改進的事件處理邏輯 ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("📨 Event:", eventType);

        // 1️⃣ 用戶語音轉文字
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const transcript = eventData.transcript || eventData.text || "";
          console.log("🗣️ User speech:", transcript);
          
          if (transcript.trim()) {
            const eventId = eventData.item_id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            postLog({ role: "user", content: transcript.trim(), eventId });
          }
        }

        // 2️⃣ 助手回應開始
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          console.log("🤖 Assistant response started:", responseId);
          
          assistantResponseState.current = {
            isActive: true,
            responseId,
            textBuffer: "",
            startTime: Date.now(),
          };
        }

        // 3️⃣ 收集所有可能的文字增量事件
        const TEXT_DELTA_EVENTS = [
          "response.text.delta",
          "response.output_text.delta", 
          "output_text.delta",
          "conversation.item.delta",
        ];

        if (TEXT_DELTA_EVENTS.some(event => eventType.includes(event))) {
          const delta = eventData.delta || eventData.text || "";
          
          if (delta && assistantResponseState.current.isActive) {
            assistantResponseState.current.textBuffer += delta;
            console.log(`📝 Added text delta (${delta.length} chars), total: ${assistantResponseState.current.textBuffer.length}`);
          }
        }

        // 4️⃣ 文字完成事件 - 作為備用檢查
        const TEXT_DONE_EVENTS = [
          "response.text.done",
          "response.output_text.done",
          "output_text.done",
        ];

        if (TEXT_DONE_EVENTS.some(event => eventType.includes(event))) {
          const completedText = eventData.text || "";
          
          if (completedText && assistantResponseState.current.isActive) {
            // 確保完整文字都在 buffer 中
            if (assistantResponseState.current.textBuffer.length < completedText.length) {
              console.log("🔄 Updating buffer with complete text");
              assistantResponseState.current.textBuffer = completedText;
            }
          }
        }

        // 5️⃣ 內容部分完成 - 另一個備用提取點
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          
          if (part?.type === "text" && part.text && assistantResponseState.current.isActive) {
            // 如果 buffer 是空的但 part 有文字，使用 part 的文字
            if (!assistantResponseState.current.textBuffer && part.text) {
              console.log("🆘 Using text from content_part.done as fallback");
              assistantResponseState.current.textBuffer = part.text;
            }
          }
        }

        // 6️⃣ 助手回應完成 - 最終記錄點（最重要）
        const RESPONSE_DONE_EVENTS = ["response.done", "response.completed"];
        
        if (RESPONSE_DONE_EVENTS.includes(eventType)) {
          console.log("🏁 Assistant response completed");
          
          let finalText = assistantResponseState.current.textBuffer.trim();
          
          // 🚨 多層級備用提取策略
          if (!finalText) {
            console.warn("⚠️ Buffer empty, trying fallback extraction");
            
            // 備用 1: 從 response.output 提取
            const response = eventData.response;
            if (response?.output) {
              finalText = extractTextFromOutput(response.output);
            }
            
            // 備用 2: 直接從事件數據提取
            if (!finalText) {
              finalText = eventData.text || eventData.content || "";
            }
            
            console.log(`💾 Fallback extraction result: ${finalText.length} chars`);
          }

          // 記錄助手回應
          if (finalText) {
            const eventId = assistantResponseState.current.responseId || `assistant_${Date.now()}`;
            const duration = Date.now() - assistantResponseState.current.startTime;
            
            console.log(`✅ Logging assistant response: ${finalText.length} chars, ${duration}ms`);
            
            postLog({
              role: "assistant",
              content: finalText,
              eventId,
            });
          } else {
            // 🚨 如果完全沒有文字，記錄詳細的調試資訊
            console.error("❌ No assistant text found after all fallback attempts!");
            console.log("🔍 Full event data:", JSON.stringify(eventData, null, 2));
            
            // 記錄一個錯誤事件用於調試
            postLog({
              role: "system", 
              content: `[ERROR] Assistant response completed but no text extracted. Event: ${eventType}`,
              eventId: `error_${Date.now()}`
            });
          }

          // 重置狀態
          assistantResponseState.current = {
            isActive: false,
            responseId: null,
            textBuffer: "",
            startTime: 0,
          };
        }

        // 7️⃣ 麥克風狀態處理
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("🎤 User started speaking");
        }
        
        if (["input_audio_buffer.speech_stopped", "input_audio_buffer.committed"].includes(eventType)) {
          setIsListening(false);
          console.log("🎤 User stopped speaking");
        }

        // 8️⃣ 錯誤處理
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
        }

        // 🔍 調試：記錄其他未處理的事件
        const KNOWN_EVENTS = [
          "session.created", "session.updated", "input_audio_buffer.speech_started",
          "input_audio_buffer.speech_stopped", "input_audio_buffer.committed",
          "conversation.item.input_audio_transcription.completed", "response.created",
          "conversation.item.created", "response.content_part.added", "response.text.delta",
          "response.output_text.delta", "output_text.delta", "response.text.done",
          "response.output_text.done", "output_text.done", "response.content_part.done",
          "response.done", "response.completed"
        ];
        
        if (!KNOWN_EVENTS.includes(eventType)) {
          console.log("🔍 Unknown event:", eventType, eventData);
        }
      });

      // 創建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });
      
      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);
    
    // 重置日誌狀態
    assistantResponseState.current = {
      isActive: false,
      responseId: null,
      textBuffer: "",
      startTime: 0,
    };
    loggedEventIds.current.clear();
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;
    
    console.log("💬 Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 立即記錄用戶文字訊息
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    postLog({ role: "user", content: textToSend, eventId });

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("🎤 PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("🎤 PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 營養師</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0815 V2

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 簡化的助手回應狀態管理 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  
  // 🛠️ 更新的助手回應狀態（新增 audioTranscriptBuffer）
  const assistantResponseState = useRef({
    isActive: false,
    responseId: null as string | null,
    textBuffer: "",
    audioTranscriptBuffer: "", // 新增：專門收集音頻轉錄
    startTime: 0,
  });

  // 防止重複記錄的 Set
  const loggedEventIds = useRef<Set<string>>(new Set());

  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!userId || !sessionId || !log.content?.trim()) {
      console.warn("🚫 postLog skipped:", { 
        hasUserId: !!userId, 
        hasSessionId: !!sessionId, 
        hasContent: !!log.content?.trim(),
        contentPreview: log.content?.substring(0, 50) + "...",
        userId: userId ? userId.substring(0, 8) + "..." : "empty",
        sessionId: sessionId ? sessionId.substring(0, 8) + "..." : "empty"
      });
      return;
    }

    // 防止重複記錄
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);
    
    const body = JSON.stringify({ ...log, userId, sessionId, eventId });
    console.log("📝 Posting log:", { 
      role: log.role, 
      content: log.content.substring(0, 100) + (log.content.length > 100 ? "..." : ""), 
      eventId,
      userId: userId.substring(0, 8) + "...",
      sessionId: sessionId.substring(0, 8) + "..."
    });
    
    try {
      if (navigator.sendBeacon) {
        const success = navigator.sendBeacon("/api/logs", new Blob([body], { type: "application/json" }));
        if (!success) {
          console.warn("📡 sendBeacon failed, falling back to fetch");
          const response = await fetch("/api/logs", { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body 
          });
          if (!response.ok) {
            console.error("❌ Log API fetch failed:", response.status, response.statusText);
          } else {
            console.log("✅ Log posted successfully via fetch");
          }
        } else {
          console.log("✅ Log posted successfully via sendBeacon");
        }
      } else {
        const response = await fetch("/api/logs", { 
          method: "POST", 
          headers: { "Content-Type": "application/json" }, 
          body 
        });
        if (!response.ok) {
          console.error("❌ Log API responded with error:", response.status, response.statusText);
        } else {
          console.log("✅ Log posted successfully");
        }
      }
    } catch (e) {
      console.error("💥 postLog failed:", e);
    }
  }

  // 🛠️ 輔助函數：從 output 數組提取文字（支援音頻轉錄）
  function extractTextFromOutput(output: any): string {
    let text = "";
    
    if (Array.isArray(output)) {
      for (const item of output) {
        // 處理 text 類型的 item
        if (item?.type === "text" && item.text) {
          text += item.text;
        } 
        // 處理有 content 的 item
        else if (item?.content) {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          for (const contentItem of content) {
            // 文字內容
            if (contentItem?.type === "text" && contentItem.text) {
              text += contentItem.text;
            }
            // 🎵 音頻內容的轉錄文字
            else if (contentItem?.type === "audio" && contentItem.transcript) {
              console.log("🎵 Found audio transcript in output:", contentItem.transcript);
              text += contentItem.transcript;
            }
          }
        }
      }
    }
    
    return text;
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 獲取 ephemeral key + userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 設置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 完全修正的事件處理邏輯 ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("📨 Event:", eventType);

        // 1️⃣ 用戶語音轉文字（修正：確保 userId 和 sessionId 存在）
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const transcript = eventData.transcript || eventData.text || "";
          console.log("🗣️ User speech:", transcript);
          
          if (transcript.trim()) {
            if (userId && sessionId) {
              const eventId = eventData.item_id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;
              postLog({ role: "user", content: transcript.trim(), eventId });
            } else {
              console.warn("🚫 User speech not logged - missing IDs:", { 
                transcript: transcript.substring(0, 50) + "...",
                hasUserId: !!userId,
                hasSessionId: !!sessionId,
                userIdPreview: userId ? userId.substring(0, 8) + "..." : "empty",
                sessionIdPreview: sessionId ? sessionId.substring(0, 8) + "..." : "empty"
              });
            }
          }
        }

        // 2️⃣ 助手回應開始
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          console.log("🤖 Assistant response started:", responseId);
          
          assistantResponseState.current = {
            isActive: true,
            responseId,
            textBuffer: "",
            audioTranscriptBuffer: "", // 重置音頻轉錄緩存
            startTime: Date.now(),
          };
        }

        // 3️⃣ 🎵 新增：音頻轉錄增量事件處理
        if (eventType === "response.audio_transcript.delta") {
          const delta = eventData.delta || "";
          
          if (delta && assistantResponseState.current.isActive) {
            assistantResponseState.current.audioTranscriptBuffer += delta;
            console.log(`🎵 Added audio transcript delta (${delta.length} chars), total: ${assistantResponseState.current.audioTranscriptBuffer.length}`);
          }
        }

        // 4️⃣ 🎵 新增：音頻轉錄完成事件處理
        if (eventType === "response.audio_transcript.done") {
          const transcript = eventData.transcript || "";
          
          if (transcript && assistantResponseState.current.isActive) {
            // 確保完整轉錄都在 buffer 中
            if (assistantResponseState.current.audioTranscriptBuffer.length < transcript.length) {
              console.log("🔄 Updating audio transcript buffer with complete text");
              assistantResponseState.current.audioTranscriptBuffer = transcript;
            }
          }
        }

        // 5️⃣ 收集所有可能的文字增量事件
        const TEXT_DELTA_EVENTS = [
          "response.text.delta",
          "response.output_text.delta", 
          "output_text.delta",
          "conversation.item.delta",
        ];

        if (TEXT_DELTA_EVENTS.some(event => eventType.includes(event))) {
          const delta = eventData.delta || eventData.text || "";
          
          if (delta && assistantResponseState.current.isActive) {
            assistantResponseState.current.textBuffer += delta;
            console.log(`📝 Added text delta (${delta.length} chars), total: ${assistantResponseState.current.textBuffer.length}`);
          }
        }

        // 6️⃣ 文字完成事件 - 作為備用檢查
        const TEXT_DONE_EVENTS = [
          "response.text.done",
          "response.output_text.done",
          "output_text.done",
        ];

        if (TEXT_DONE_EVENTS.some(event => eventType.includes(event))) {
          const completedText = eventData.text || "";
          
          if (completedText && assistantResponseState.current.isActive) {
            // 確保完整文字都在 buffer 中
            if (assistantResponseState.current.textBuffer.length < completedText.length) {
              console.log("🔄 Updating buffer with complete text");
              assistantResponseState.current.textBuffer = completedText;
            }
          }
        }

        // 7️⃣ 內容部分完成 - 另一個備用提取點
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          
          if (part?.type === "text" && part.text && assistantResponseState.current.isActive) {
            // 如果 buffer 是空的但 part 有文字，使用 part 的文字
            if (!assistantResponseState.current.textBuffer && part.text) {
              console.log("🆘 Using text from content_part.done as fallback");
              assistantResponseState.current.textBuffer = part.text;
            }
          }
        }

        // 8️⃣ 助手回應完成 - 最終記錄點（最重要）
        const RESPONSE_DONE_EVENTS = ["response.done", "response.completed"];
        
        if (RESPONSE_DONE_EVENTS.includes(eventType)) {
          console.log("🏁 Assistant response completed");
          
          let finalText = assistantResponseState.current.textBuffer.trim();
          
          // 🚨 多層級備用提取策略
          if (!finalText) {
            console.warn("⚠️ Text buffer empty, trying fallback extraction");
            
            // 🎵 優先使用音頻轉錄
            if (assistantResponseState.current.audioTranscriptBuffer.trim()) {
              finalText = assistantResponseState.current.audioTranscriptBuffer.trim();
              console.log("🎵 Using audio transcript as primary text:", finalText.substring(0, 50) + "...");
            }
            
            // 備用 1: 從 response.output 提取
            if (!finalText) {
              const response = eventData.response;
              if (response?.output) {
                finalText = extractTextFromOutput(response.output);
                console.log("📦 Extracted from response.output:", finalText.substring(0, 50) + "...");
              }
            }
            
            // 備用 2: 直接從事件數據提取
            if (!finalText) {
              finalText = eventData.text || eventData.content || "";
              console.log("🔍 Extracted from event data:", finalText.substring(0, 50) + "...");
            }
            
            console.log(`💾 Fallback extraction result: ${finalText.length} chars`);
          }

          // 記錄助手回應 - 修正條件檢查
          if (finalText.trim()) {
            if (userId && sessionId) {
              const eventId = assistantResponseState.current.responseId || `assistant_${Date.now()}`;
              const duration = Date.now() - assistantResponseState.current.startTime;
              
              console.log(`✅ Logging assistant response: ${finalText.length} chars, ${duration}ms`);
              console.log(`📝 Content preview: ${finalText.substring(0, 100)}${finalText.length > 100 ? "..." : ""}`);
              
              postLog({
                role: "assistant",
                content: finalText.trim(),
                eventId,
              });
            } else {
              console.warn("🚫 Assistant response not logged - missing IDs:", {
                finalTextLength: finalText.length,
                contentPreview: finalText.substring(0, 50) + "...",
                hasUserId: !!userId,
                hasSessionId: !!sessionId,
                userIdPreview: userId ? userId.substring(0, 8) + "..." : "empty",
                sessionIdPreview: sessionId ? sessionId.substring(0, 8) + "..." : "empty"
              });
            }
          } else {
            // 🚨 如果完全沒有文字，記錄詳細的調試資訊
            console.error("❌ No assistant text found after all fallback attempts!");
            console.log("🔍 Debug info:", { 
              hasUserId: !!userId,
              hasSessionId: !!sessionId,
              textBufferLength: assistantResponseState.current.textBuffer.length,
              audioBufferLength: assistantResponseState.current.audioTranscriptBuffer.length,
              textBuffer: assistantResponseState.current.textBuffer,
              audioBuffer: assistantResponseState.current.audioTranscriptBuffer,
              eventDataKeys: Object.keys(eventData),
              responseKeys: eventData.response ? Object.keys(eventData.response) : "no response"
            });
            
            // 記錄一個錯誤事件用於調試
            if (userId && sessionId) {
              postLog({
                role: "system", 
                content: `[ERROR] Assistant response completed but no text extracted. Event: ${eventType}, TextBuffer: ${assistantResponseState.current.textBuffer.length}, AudioBuffer: ${assistantResponseState.current.audioTranscriptBuffer.length}`,
                eventId: `error_${Date.now()}`
              });
            }
          }

          // 重置狀態
          assistantResponseState.current = {
            isActive: false,
            responseId: null,
            textBuffer: "",
            audioTranscriptBuffer: "", // 重置音頻轉錄緩存
            startTime: 0,
          };
        }

        // 9️⃣ 麥克風狀態處理
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("🎤 User started speaking");
        }
        
        if (["input_audio_buffer.speech_stopped", "input_audio_buffer.committed"].includes(eventType)) {
          setIsListening(false);
          console.log("🎤 User stopped speaking");
        }

        // 🔟 錯誤處理
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
        }

        // 🔍 調試：記錄其他未處理的事件（更新已知事件列表）
        const KNOWN_EVENTS = [
          "session.created", "session.updated", "input_audio_buffer.speech_started",
          "input_audio_buffer.speech_stopped", "input_audio_buffer.committed",
          "conversation.item.input_audio_transcription.completed", 
          "conversation.item.input_audio_transcription.failed",
          "response.created", "conversation.item.created", "response.content_part.added", 
          "response.text.delta", "response.output_text.delta", "output_text.delta", 
          "response.text.done", "response.output_text.done", "output_text.done", 
          "response.content_part.done", "response.done", "response.completed",
          // 新增音頻相關事件
          "response.audio_transcript.delta", "response.audio_transcript.done",
          "response.audio.done", "response.output_item.done", "rate_limits.updated",
          "output_audio_buffer.stopped", "input_audio_buffer.cleared"
        ];
        
        if (!KNOWN_EVENTS.includes(eventType)) {
          console.log("🔍 Unknown event:", eventType, eventData);
        }

        // 🚨 特別監控用戶語音相關事件
        if (eventType.includes("input_audio") || eventType.includes("transcription")) {
          console.log("🎤 Audio-related event:", eventType, {
            transcript: eventData.transcript || eventData.text,
            item_id: eventData.item_id,
            hasUserId: !!userId,
            hasSessionId: !!sessionId
          });
        }
      });

      // 創建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });
      
      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);
    
    // 重置日誌狀態
    assistantResponseState.current = {
      isActive: false,
      responseId: null,
      textBuffer: "",
      audioTranscriptBuffer: "", // 重置音頻轉錄緩存
      startTime: 0,
    };
    loggedEventIds.current.clear();
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;
    
    console.log("💬 Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 立即記錄用戶文字訊息
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    postLog({ role: "user", content: textToSend, eventId });

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("🎤 PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("🎤 PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 營養師</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0819 V1 fixing the user STT, respone missing

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 簡化的助手回應狀態管理 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  
  // 🛠️ 更新的助手回應狀態（新增 audioTranscriptBuffer）
  const assistantResponseState = useRef({
    isActive: false,
    responseId: null as string | null,
    textBuffer: "",
    audioTranscriptBuffer: "", // 新增：專門收集音頻轉錄
    startTime: 0,
  });

  // 防止重複記錄的 Set
  const loggedEventIds = useRef<Set<string>>(new Set());

  // 🆕 新增待送佇列
  const pendingLogsRef = useRef<
    Array<{ role: "user" | "assistant" | "system"; content: string; eventId?: string }>
  >([]);

  // 🆕 把原本 postLog 內的真正送出邏輯抽成一個函式
  async function reallyPostLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);
    
    const body = JSON.stringify({ ...log, userId, sessionId, eventId });
    console.log("📝 Posting log:", { 
      role: log.role, 
      content: log.content.substring(0, 100) + (log.content.length > 100 ? "..." : ""), 
      eventId,
      userId: userId.substring(0, 8) + "...",
      sessionId: sessionId.substring(0, 8) + "..."
    });
    
    try {
      if (navigator.sendBeacon) {
        const success = navigator.sendBeacon("/api/logs", new Blob([body], { type: "application/json" }));
        if (!success) {
          console.warn("📡 sendBeacon failed, falling back to fetch");
          const response = await fetch("/api/logs", { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body 
          });
          if (!response.ok) {
            console.error("❌ Log API fetch failed:", response.status, response.statusText);
          } else {
            console.log("✅ Log posted successfully via fetch");
          }
        } else {
          console.log("✅ Log posted successfully via sendBeacon");
        }
      } else {
        const response = await fetch("/api/logs", { 
          method: "POST", 
          headers: { "Content-Type": "application/json" }, 
          body 
        });
        if (!response.ok) {
          console.error("❌ Log API responded with error:", response.status, response.statusText);
        } else {
          console.log("✅ Log posted successfully");
        }
      }
    } catch (e) {
      console.error("💥 postLog failed:", e);
    }
  }

  // 🆕 取代原本的 postLog：若 ID 未就緒先排隊，不要丟掉
  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!log.content?.trim()) {
      console.warn("🚫 postLog skipped: empty content");
      return;
    }

    // 先產生 eventId，讓去重在「排隊階段」就生效
    if (!log.eventId) {
      log.eventId = `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    
    if (loggedEventIds.current.has(log.eventId)) {
      console.warn("🔄 Duplicate log prevented (queued):", log.eventId);
      return;
    }

    if (!userId || !sessionId) {
      console.warn("⏸️ postLog queued (IDs not ready yet):", { 
        role: log.role, 
        preview: log.content.slice(0, 50) + "...",
        eventId: log.eventId,
        hasUserId: !!userId,
        hasSessionId: !!sessionId,
        queueLength: pendingLogsRef.current.length
      });
      pendingLogsRef.current.push(log);
      return;
    }

    await reallyPostLog(log);
  }

  // 🆕 IDs 一到位就把隊列 flush
  useEffect(() => {
    if (userId && sessionId && pendingLogsRef.current.length > 0) {
      console.log(`🚀 Flushing pending logs queue: ${pendingLogsRef.current.length} items`);
      const queue = [...pendingLogsRef.current];
      pendingLogsRef.current.length = 0;
      queue.forEach((log) => reallyPostLog(log));
    }
  }, [userId, sessionId]);

  // 🛠️ 輔助函數：從 output 數組提取文字（支援音頻轉錄）
  function extractTextFromOutput(output: any): string {
    let text = "";
    
    if (Array.isArray(output)) {
      for (const item of output) {
        // 處理 text 類型的 item
        if (item?.type === "text" && item.text) {
          text += item.text;
        } 
        // 處理有 content 的 item
        else if (item?.content) {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          for (const contentItem of content) {
            // 文字內容
            if (contentItem?.type === "text" && contentItem.text) {
              text += contentItem.text;
            }
            // 🎵 音頻內容的轉錄文字
            else if (contentItem?.type === "audio" && contentItem.transcript) {
              console.log("🎵 Found audio transcript in output:", contentItem.transcript);
              text += contentItem.transcript;
            }
          }
        }
      }
    }
    
    return text;
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 獲取 ephemeral key + userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 設置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });
      
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });
      
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 完全修正的事件處理邏輯 ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("📨 Event:", eventType);

        // 1️⃣ 🆕 改進的用戶語音轉文字處理
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const raw = eventData.transcript || eventData.text || "";
          const normalized = (raw && raw.trim() && raw.trim() !== "\n") ? raw.trim() : "[inaudible]";
          const eventId = eventData.item_id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          
          console.log("🗣️ User speech:", normalized);
          
          // 一律呼叫 postLog（會在 ID 未就緒時先排隊）
          postLog({ role: "user", content: normalized, eventId });
        }

        // 2️⃣ 助手回應開始
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          console.log("🤖 Assistant response started:", responseId);
          
          assistantResponseState.current = {
            isActive: true,
            responseId,
            textBuffer: "",
            audioTranscriptBuffer: "", // 重置音頻轉錄緩存
            startTime: Date.now(),
          };
        }

        // 3️⃣ 🎵 新增：音頻轉錄增量事件處理
        if (eventType === "response.audio_transcript.delta") {
          const delta = eventData.delta || "";
          
          if (delta && assistantResponseState.current.isActive) {
            assistantResponseState.current.audioTranscriptBuffer += delta;
            console.log(`🎵 Added audio transcript delta (${delta.length} chars), total: ${assistantResponseState.current.audioTranscriptBuffer.length}`);
          }
        }

        // 4️⃣ 🎵 新增：音頻轉錄完成事件處理
        if (eventType === "response.audio_transcript.done") {
          const transcript = eventData.transcript || "";
          
          if (transcript && assistantResponseState.current.isActive) {
            // 確保完整轉錄都在 buffer 中
            if (assistantResponseState.current.audioTranscriptBuffer.length < transcript.length) {
              console.log("🔄 Updating audio transcript buffer with complete text");
              assistantResponseState.current.audioTranscriptBuffer = transcript;
            }
          }
        }

        // 5️⃣ 收集所有可能的文字增量事件
        const TEXT_DELTA_EVENTS = [
          "response.text.delta",
          "response.output_text.delta", 
          "output_text.delta",
          "conversation.item.delta",
        ];

        if (TEXT_DELTA_EVENTS.some(event => eventType.includes(event))) {
          const delta = eventData.delta || eventData.text || "";
          
          if (delta && assistantResponseState.current.isActive) {
            assistantResponseState.current.textBuffer += delta;
            console.log(`📝 Added text delta (${delta.length} chars), total: ${assistantResponseState.current.textBuffer.length}`);
          }
        }

        // 6️⃣ 文字完成事件 - 作為備用檢查
        const TEXT_DONE_EVENTS = [
          "response.text.done",
          "response.output_text.done",
          "output_text.done",
        ];

        if (TEXT_DONE_EVENTS.some(event => eventType.includes(event))) {
          const completedText = eventData.text || "";
          
          if (completedText && assistantResponseState.current.isActive) {
            // 確保完整文字都在 buffer 中
            if (assistantResponseState.current.textBuffer.length < completedText.length) {
              console.log("🔄 Updating buffer with complete text");
              assistantResponseState.current.textBuffer = completedText;
            }
          }
        }

        // 7️⃣ 內容部分完成 - 另一個備用提取點
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          
          if (part?.type === "text" && part.text && assistantResponseState.current.isActive) {
            // 如果 buffer 是空的但 part 有文字，使用 part 的文字
            if (!assistantResponseState.current.textBuffer && part.text) {
              console.log("🆘 Using text from content_part.done as fallback");
              assistantResponseState.current.textBuffer = part.text;
            }
          }
        }

        // 8️⃣ 助手回應完成 - 最終記錄點（最重要）
        const RESPONSE_DONE_EVENTS = ["response.done", "response.completed"];
        
        if (RESPONSE_DONE_EVENTS.includes(eventType)) {
          console.log("🏁 Assistant response completed");
          
          let finalText = assistantResponseState.current.textBuffer.trim();
          
          // 🚨 多層級備用提取策略
          if (!finalText) {
            console.warn("⚠️ Text buffer empty, trying fallback extraction");
            
            // 🎵 優先使用音頻轉錄
            if (assistantResponseState.current.audioTranscriptBuffer.trim()) {
              finalText = assistantResponseState.current.audioTranscriptBuffer.trim();
              console.log("🎵 Using audio transcript as primary text:", finalText.substring(0, 50) + "...");
            }
            
            // 備用 1: 從 response.output 提取
            if (!finalText) {
              const response = eventData.response;
              if (response?.output) {
                finalText = extractTextFromOutput(response.output);
                console.log("📦 Extracted from response.output:", finalText.substring(0, 50) + "...");
              }
            }
            
            // 備用 2: 直接從事件數據提取
            if (!finalText) {
              finalText = eventData.text || eventData.content || "";
              console.log("🔍 Extracted from event data:", finalText.substring(0, 50) + "...");
            }
            
            console.log(`💾 Fallback extraction result: ${finalText.length} chars`);
          }

          // 記錄助手回應 - 🆕 現在使用佇列機制
          if (finalText.trim()) {
            const eventId = assistantResponseState.current.responseId || `assistant_${Date.now()}`;
            const duration = Date.now() - assistantResponseState.current.startTime;
            
            console.log(`✅ Logging assistant response: ${finalText.length} chars, ${duration}ms`);
            console.log(`📝 Content preview: ${finalText.substring(0, 100)}${finalText.length > 100 ? "..." : ""}`);
            
            postLog({
              role: "assistant",
              content: finalText.trim(),
              eventId,
            });
          } else {
            // 🚨 如果完全沒有文字，記錄詳細的調試資訊
            console.error("❌ No assistant text found after all fallback attempts!");
            console.log("🔍 Debug info:", { 
              hasUserId: !!userId,
              hasSessionId: !!sessionId,
              textBufferLength: assistantResponseState.current.textBuffer.length,
              audioBufferLength: assistantResponseState.current.audioTranscriptBuffer.length,
              textBuffer: assistantResponseState.current.textBuffer,
              audioBuffer: assistantResponseState.current.audioTranscriptBuffer,
              eventDataKeys: Object.keys(eventData),
              responseKeys: eventData.response ? Object.keys(eventData.response) : "no response"
            });
            
            // 記錄一個錯誤事件用於調試
            postLog({
              role: "system", 
              content: `[ERROR] Assistant response completed but no text extracted. Event: ${eventType}, TextBuffer: ${assistantResponseState.current.textBuffer.length}, AudioBuffer: ${assistantResponseState.current.audioTranscriptBuffer.length}`,
              eventId: `error_${Date.now()}`
            });
          }

          // 重置狀態
          assistantResponseState.current = {
            isActive: false,
            responseId: null,
            textBuffer: "",
            audioTranscriptBuffer: "", // 重置音頻轉錄緩存
            startTime: 0,
          };
        }

        // 9️⃣ 麥克風狀態處理
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("🎤 User started speaking");
        }
        
        if (["input_audio_buffer.speech_stopped", "input_audio_buffer.committed"].includes(eventType)) {
          setIsListening(false);
          console.log("🎤 User stopped speaking");
        }

        // 🔟 錯誤處理
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
        }

        // 🔍 調試：記錄其他未處理的事件（更新已知事件列表）
        const KNOWN_EVENTS = [
          "session.created", "session.updated", "input_audio_buffer.speech_started",
          "input_audio_buffer.speech_stopped", "input_audio_buffer.committed",
          "conversation.item.input_audio_transcription.completed", 
          "conversation.item.input_audio_transcription.failed",
          "response.created", "conversation.item.created", "response.content_part.added", 
          "response.text.delta", "response.output_text.delta", "output_text.delta", 
          "response.text.done", "response.output_text.done", "output_text.done", 
          "response.content_part.done", "response.done", "response.completed",
          // 新增音頻相關事件
          "response.audio_transcript.delta", "response.audio_transcript.done",
          "response.audio.done", "response.output_item.done", "rate_limits.updated",
          "output_audio_buffer.stopped", "input_audio_buffer.cleared"
        ];
        
        if (!KNOWN_EVENTS.includes(eventType)) {
          console.log("🔍 Unknown event:", eventType, eventData);
        }

        // 🚨 特別監控用戶語音相關事件
        if (eventType.includes("input_audio") || eventType.includes("transcription")) {
          console.log("🎤 Audio-related event:", eventType, {
            transcript: eventData.transcript || eventData.text,
            item_id: eventData.item_id,
            hasUserId: !!userId,
            hasSessionId: !!sessionId
          });
        }
      });

      // 創建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });
      
      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);
    
    // 重置日誌狀態
    assistantResponseState.current = {
      isActive: false,
      responseId: null,
      textBuffer: "",
      audioTranscriptBuffer: "", // 重置音頻轉錄緩存
      startTime: 0,
    };
    loggedEventIds.current.clear();
    pendingLogsRef.current.length = 0; // 🆕 清空待送佇列
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;
    
    console.log("💬 Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 立即記錄用戶文字訊息 - 🆕 現在也使用佇列機制
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    postLog({ role: "user", content: textToSend, eventId });

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("🎤 PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("🎤 PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 營養師</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0820 V1 Final Version checkpoint!!!!!

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 簡化的助手回應狀態管理 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");

  // 🛠️ 更新的助手回應狀態（新增 audioTranscriptBuffer）
  const assistantResponseState = useRef({
    isActive: false,
    responseId: null as string | null,
    textBuffer: "",
    audioTranscriptBuffer: "", // 新增：專門收集音頻轉錄
    startTime: 0,
  });

  // 防止重複記錄的 Set
  const loggedEventIds = useRef<Set<string>>(new Set());

  // 🆕（仍保留，但不再用於 userId/sessionId gating）
  const pendingLogsRef = useRef<
    Array<{ role: "user" | "assistant" | "system"; content: string; eventId?: string }>
  >([]);

  // 🔧 改寫：一律用 fetch keepalive，並帶 userId/sessionId 的 fallback（unknown）
  async function reallyPostLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);

    const uid = userId || "unknown";
    const sid = sessionId || "unknown";
    const payload = { ...log, userId: uid, sessionId: sid, eventId };

    try {
      const res = await fetch("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true, // 🔧 關鍵：離開頁面或背景也盡量送出
      });
      if (!res.ok) {
        console.error("❌ Log API failed:", res.status, res.statusText);
      } else {
        console.log("✅ Log posted:", {
          role: log.role,
          eventId,
          preview: log.content.slice(0, 100) + (log.content.length > 100 ? "..." : ""),
          uid,
          sid,
        });
      }
    } catch (e) {
      console.error("💥 postLog failed, queued:", e);
      // 若送失敗，暫存待送
      pendingLogsRef.current.push({ ...log, eventId });
    }
  }

  // 🔧 改寫：不再等 userId/sessionId——直接送；若失敗才入佇列
  async function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!log.content?.trim()) {
      console.warn("🚫 postLog skipped: empty content");
      return;
    }
    if (!log.eventId) {
      log.eventId = `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    if (loggedEventIds.current.has(log.eventId)) {
      console.warn("🔄 Duplicate log prevented (pre-flight):", log.eventId);
      return;
    }
    await reallyPostLog(log);
  }

  // 🔧 佇列 flush：當 ID 到位或裝置回到線上時，一併送出
  useEffect(() => {
    const flush = async () => {
      if (pendingLogsRef.current.length === 0) return;
      console.log(`🚀 Flushing pending logs queue: ${pendingLogsRef.current.length} items`);
      const queue = [...pendingLogsRef.current];
      pendingLogsRef.current.length = 0;
      for (const log of queue) {
        await reallyPostLog(log);
      }
    };
    flush();

    const onOnline = () => flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [userId, sessionId]);

  // 🛠️ 輔助函數：從 output 數組提取文字（支援音頻轉錄）
  function extractTextFromOutput(output: any): string {
    let text = "";
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item?.type === "text" && item.text) {
          text += item.text;
        } else if (item?.content) {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          for (const contentItem of content) {
            if (contentItem?.type === "text" && contentItem.text) {
              text += contentItem.text;
            } else if (contentItem?.type === "audio" && contentItem.transcript) {
              console.log("🎵 Found audio transcript in output:", contentItem.transcript);
              text += contentItem.transcript;
            }
          }
        }
      }
    }
    return text;
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      // 獲取 ephemeral key + userId/sessionId
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 設置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });

      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });

      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 事件處理邏輯（含擴充的 logging） ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("📨 Event:", eventType);

        // 1️⃣ 使用者 STT：官方 completed 事件
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const raw = eventData.transcript || eventData.text || "";
          const normalized = raw && raw.trim() && raw.trim() !== "\n" ? raw.trim() : "[inaudible]";
          const eventId = eventData.item_id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          console.log("🗣️ User speech (completed):", normalized);
          postLog({ role: "user", content: normalized, eventId });
        }

        // 🔧 1.1 使用者 STT：補捉 item.created（只記錄 transcript，避免跟 input_text 重複）
        if (eventType === "conversation.item.created") {
          const item = eventData.item;
          if (item?.role === "user" && Array.isArray(item.content)) {
            const transcripts = item.content
              .map((c: any) => c?.transcript)
              .filter(Boolean) as string[];
            const joined = transcripts.join("").trim();
            if (joined) {
              console.log("🗣️ User speech (created->transcript):", joined);
              postLog({ role: "user", content: joined, eventId: item.id });
            }
          }
        }

        // 🔧 1.2 STT 失敗也紀錄
        if (eventType === "conversation.item.input_audio_transcription.failed") {
          const reason = eventData?.error || "unknown";
          postLog({
            role: "system",
            content: `[STT FAILED] ${String(reason).slice(0, 200)}`,
            eventId: eventData.item_id || `stt_fail_${Date.now()}`,
          });
        }

        // 2️⃣ 助手回應開始
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          console.log("🤖 Assistant response started:", responseId);
          assistantResponseState.current = {
            isActive: true,
            responseId,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: Date.now(),
          };
        }

        // 3️⃣ 音頻轉錄增量/完成（對應語音輸出時的字幕文字）
        if (eventType === "response.audio_transcript.delta") {
          const delta = eventData.delta || "";
          if (delta && assistantResponseState.current.isActive) {
            assistantResponseState.current.audioTranscriptBuffer += delta;
            console.log(`🎵 Added audio transcript delta (${delta.length} chars), total: ${assistantResponseState.current.audioTranscriptBuffer.length}`);
          }
        }
        if (eventType === "response.audio_transcript.done") {
          const transcript = eventData.transcript || "";
          if (transcript && assistantResponseState.current.isActive) {
            if (assistantResponseState.current.audioTranscriptBuffer.length < transcript.length) {
              assistantResponseState.current.audioTranscriptBuffer = transcript;
            }
          }
        }

        // 4️⃣ 文字增量事件
        const TEXT_DELTA_EVENTS = [
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "conversation.item.delta",
        ];
        if (TEXT_DELTA_EVENTS.some((ev) => eventType.includes(ev))) {
          const delta = eventData.delta || eventData.text || "";
          if (delta && assistantResponseState.current.isActive) {
            assistantResponseState.current.textBuffer += delta;
            console.log(`📝 Added text delta (${delta.length} chars), total: ${assistantResponseState.current.textBuffer.length}`);
          }
        }

        // 5️⃣ 文字完成事件（備用）
        const TEXT_DONE_EVENTS = ["response.text.done", "response.output_text.done", "output_text.done"];
        if (TEXT_DONE_EVENTS.some((ev) => eventType.includes(ev))) {
          const completedText = eventData.text || "";
          if (completedText && assistantResponseState.current.isActive) {
            if (assistantResponseState.current.textBuffer.length < completedText.length) {
              console.log("🔄 Updating buffer with complete text (text.done)");
              assistantResponseState.current.textBuffer = completedText;
            }
          }

          // 🔧 先行結單：有些情況拿不到 response.completed
          const candidate =
            assistantResponseState.current.textBuffer.trim() ||
            assistantResponseState.current.audioTranscriptBuffer.trim() ||
            completedText.trim();
          if (candidate) {
            const eventId =
              assistantResponseState.current.responseId ||
              eventData.response?.id ||
              eventData.id ||
              `assistant_${Date.now()}`;
            postLog({ role: "assistant", content: candidate, eventId });
            // 標記本輪已完成，避免後續重複
            assistantResponseState.current = {
              isActive: false,
              responseId: null,
              textBuffer: "",
              audioTranscriptBuffer: "",
              startTime: 0,
            };
          }
        }

        // 6️⃣ 內容部分完成（再一層備援提取）
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          if (part?.type === "text" && part.text && assistantResponseState.current.isActive) {
            if (!assistantResponseState.current.textBuffer) {
              console.log("🆘 Using text from content_part.done as fallback");
              assistantResponseState.current.textBuffer = part.text;
            }
          }
        }

        // 7️⃣ 助手回應完成（最終備援）
        const RESPONSE_DONE_EVENTS = ["response.done", "response.completed"];
        if (RESPONSE_DONE_EVENTS.includes(eventType)) {
          console.log("🏁 Assistant response completed");

          let finalText = assistantResponseState.current.textBuffer.trim();

          if (!finalText) {
            console.warn("⚠️ Text buffer empty, trying fallback extraction");
            if (assistantResponseState.current.audioTranscriptBuffer.trim()) {
              finalText = assistantResponseState.current.audioTranscriptBuffer.trim();
              console.log("🎵 Using audio transcript as primary text:", finalText.substring(0, 50) + "...");
            }
            if (!finalText) {
              const response = eventData.response;
              if (response?.output) {
                finalText = extractTextFromOutput(response.output);
                if (finalText) {
                  console.log("📦 Extracted from response.output:", finalText.substring(0, 50) + "...");
                }
              }
            }
            if (!finalText) {
              finalText = (eventData.text || eventData.content || "").trim();
              if (finalText) {
                console.log("🔍 Extracted from event data:", finalText.substring(0, 50) + "...");
              }
            }
          }

          if (finalText) {
            const eventId =
              assistantResponseState.current.responseId ||
              eventData.response?.id ||
              eventData.id ||
              `assistant_${Date.now()}`;
            const duration = Date.now() - assistantResponseState.current.startTime;
            console.log(`✅ Logging assistant response: ${finalText.length} chars, ${duration}ms`);
            postLog({ role: "assistant", content: finalText, eventId });
          } else {
            console.error("❌ No assistant text found after all fallback attempts!");
            postLog({
              role: "system",
              content: `[ERROR] Assistant response completed but no text extracted. Event: ${eventType}`,
              eventId: `error_${Date.now()}`,
            });
          }

          // 重置狀態
          assistantResponseState.current = {
            isActive: false,
            responseId: null,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: 0,
          };
        }

        // 8️⃣ 麥克風狀態處理
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("🎤 User started speaking");
        }
        if (["input_audio_buffer.speech_stopped", "input_audio_buffer.committed"].includes(eventType)) {
          setIsListening(false);
          console.log("🎤 User stopped speaking");
        }

        // 9️⃣ 錯誤處理
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
          postLog({
            role: "system",
            content: `[REALTIME ERROR] ${JSON.stringify(eventData).slice(0, 500)}`,
            eventId: eventData?.event_id || `rt_error_${Date.now()}`,
          });
        }

        // 🔍 調試：記錄其他未處理的事件（更新已知事件列表）
        const KNOWN_EVENTS = [
          "session.created",
          "session.updated",
          "input_audio_buffer.speech_started",
          "input_audio_buffer.speech_stopped",
          "input_audio_buffer.committed",
          "conversation.item.input_audio_transcription.completed",
          "conversation.item.input_audio_transcription.failed",
          "conversation.item.created", // 🔧 新增
          "response.created",
          "conversation.item.created",
          "response.content_part.added",
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "response.text.done",
          "response.output_text.done",
          "output_text.done",
          "response.content_part.done",
          "response.done",
          "response.completed",
          "response.audio_transcript.delta",
          "response.audio_transcript.done",
          "response.audio.done",
          "response.output_item.done",
          "rate_limits.updated",
          "output_audio_buffer.stopped",
          "input_audio_buffer.cleared",
        ];

        if (!KNOWN_EVENTS.includes(eventType)) {
          console.log("🔍 Unknown event:", eventType, eventData);
        }

        // 🚨 特別監控用戶語音相關事件
        if (eventType.includes("input_audio") || eventType.includes("transcription")) {
          console.log("🎤 Audio-related event:", eventType, {
            transcript: eventData.transcript || eventData.text,
            item_id: eventData.item_id,
            hasUserId: !!userId,
            hasSessionId: !!sessionId,
          });
        }
      });

      // 創建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });

      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);

    // 重置日誌狀態
    assistantResponseState.current = {
      isActive: false,
      responseId: null,
      textBuffer: "",
      audioTranscriptBuffer: "",
      startTime: 0,
    };
    loggedEventIds.current.clear();
    pendingLogsRef.current.length = 0;
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === " " + selectedAgentName || a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;

    console.log("💬 Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 立即記錄用戶文字訊息（仍保留）
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    postLog({ role: "user", content: textToSend, eventId });

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("🎤 PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("🎤 PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 營養師</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0820 fixing the logs order -> QA sequence

/*"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 對話管理狀態 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");

  // 🔄 新的對話管理系統
  const conversationState = useRef({
    currentUserMessage: null as { content: string; eventId: string; timestamp: number } | null,
    currentAssistantResponse: {
      isActive: false,
      responseId: null as string | null,
      textBuffer: "",
      audioTranscriptBuffer: "",
      startTime: 0,
    },
    conversationPairs: [] as Array<{
      user: { content: string; eventId: string; timestamp: number };
      assistant: { content: string; eventId: string; timestamp: number } | null;
      pairId: string;
    }>,
  });

  // 防重複記錄
  const loggedEventIds = useRef<Set<string>>(new Set());
  const pendingLogsRef = useRef<
    Array<{ role: "user" | "assistant" | "system"; content: string; eventId?: string }>
  >([]);

  // 🆕 對話配對日誌函數
  function logConversationPair(userMsg: { content: string; eventId: string; timestamp: number }, assistantMsg: { content: string; eventId: string; timestamp: number }) {
    const pairId = `pair_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    // 先記錄用戶訊息
    reallyPostLog({ 
      role: "user", 
      content: userMsg.content, 
      eventId: userMsg.eventId,
      pairId,
      timestamp: userMsg.timestamp
    }).then(() => {
      // 再記錄助手回應
      return reallyPostLog({ 
        role: "assistant", 
        content: assistantMsg.content, 
        eventId: assistantMsg.eventId,
        pairId,
        timestamp: assistantMsg.timestamp
      });
    }).then(() => {
      console.log(`📝 Logged conversation pair: Q(${userMsg.content.slice(0, 30)}...) -> A(${assistantMsg.content.slice(0, 30)}...)`);
    }).catch((error) => {
      console.error("💥 Error logging conversation pair:", error);
    });
  }

  // 🔧 更新的 reallyPostLog 函數
  async function reallyPostLog(log: { 
    role: "user" | "assistant" | "system"; 
    content: string; 
    eventId?: string;
    pairId?: string;
    timestamp?: number;
  }) {
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);

    const uid = userId || "unknown";
    const sid = sessionId || "unknown";
    const payload = { 
      ...log, 
      userId: uid, 
      sessionId: sid, 
      eventId,
      timestamp: log.timestamp || Date.now()
    };

    try {
      const res = await fetch("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!res.ok) {
        console.error("❌ Log API failed:", res.status, res.statusText);
      } else {
        console.log("✅ Log posted:", {
          role: log.role,
          eventId,
          pairId: log.pairId,
          preview: log.content.slice(0, 100) + (log.content.length > 100 ? "..." : ""),
          uid,
          sid,
        });
      }
    } catch (e) {
      console.error("💥 postLog failed:", e);
      pendingLogsRef.current.push({ ...log, eventId });
    }
  }

  // 保留原本的 postLog（用於系統訊息）
  function postLog(log: { role: "user" | "assistant" | "system"; content: string; eventId?: string }) {
    if (!log.content?.trim()) {
      console.warn("🚫 postLog skipped: empty content");
      return;
    }
    if (!log.eventId) {
      log.eventId = `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    if (loggedEventIds.current.has(log.eventId)) {
      console.warn("🔄 Duplicate log prevented (pre-flight):", log.eventId);
      return;
    }
    reallyPostLog(log).catch((error) => {
      console.error("💥 Error in postLog:", error);
    });
  }

  // 佇列 flush
  useEffect(() => {
    const flush = async () => {
      if (pendingLogsRef.current.length === 0) return;
      console.log(`🚀 Flushing pending logs queue: ${pendingLogsRef.current.length} items`);
      const queue = [...pendingLogsRef.current];
      pendingLogsRef.current.length = 0;
      for (const log of queue) {
        await reallyPostLog(log);
      }
    };
    flush();

    const onOnline = () => flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [userId, sessionId]);

  // 輔助函數：從 output 數組提取文字
  function extractTextFromOutput(output: any): string {
    let text = "";
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item?.type === "text" && item.text) {
          text += item.text;
        } else if (item?.content) {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          for (const contentItem of content) {
            if (contentItem?.type === "text" && contentItem.text) {
              text += contentItem.text;
            } else if (contentItem?.type === "audio" && contentItem.transcript) {
              console.log("🎵 Found audio transcript in output:", contentItem.transcript);
              text += contentItem.transcript;
            }
          }
        }
      }
    }
    return text;
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 設置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });

      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });

      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 重構的事件處理邏輯 ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("📨 Event:", eventType);

        // 1️⃣ 用戶語音輸入完成
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const raw = eventData.transcript || eventData.text || "";
          const normalized = raw && raw.trim() && raw.trim() !== "\n" ? raw.trim() : "[inaudible]";
          const eventId = eventData.item_id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          
          console.log("🗣️ User speech completed:", normalized);
          
          // 暫存用戶訊息，等待助手回應完成後一起記錄
          conversationState.current.currentUserMessage = {
            content: normalized,
            eventId,
            timestamp: Date.now()
          };
        }

        // 1.1 補捉 item.created（語音轉錄）
        if (eventType === "conversation.item.created") {
          const item = eventData.item;
          if (item?.role === "user" && Array.isArray(item.content)) {
            const transcripts = item.content
              .map((c: any) => c?.transcript)
              .filter(Boolean) as string[];
            const joined = transcripts.join("").trim();
            if (joined && !conversationState.current.currentUserMessage) {
              console.log("🗣️ User speech (created->transcript):", joined);
              conversationState.current.currentUserMessage = {
                content: joined,
                eventId: item.id,
                timestamp: Date.now()
              };
            }
          }
        }

        // 1.2 STT 失敗記錄（系統訊息，直接記錄）
        if (eventType === "conversation.item.input_audio_transcription.failed") {
          const reason = eventData?.error || "unknown";
          postLog({
            role: "system",
            content: `[STT FAILED] ${String(reason).slice(0, 200)}`,
            eventId: eventData.item_id || `stt_fail_${Date.now()}`,
          });
        }

        // 2️⃣ 助手回應開始
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          console.log("🤖 Assistant response started:", responseId);
          conversationState.current.currentAssistantResponse = {
            isActive: true,
            responseId,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: Date.now(),
          };
        }

        // 3️⃣ 音頻轉錄增量
        if (eventType === "response.audio_transcript.delta") {
          const delta = eventData.delta || "";
          if (delta && conversationState.current.currentAssistantResponse.isActive) {
            conversationState.current.currentAssistantResponse.audioTranscriptBuffer += delta;
            console.log(`🎵 Added audio transcript delta (${delta.length} chars)`);
          }
        }
        if (eventType === "response.audio_transcript.done") {
          const transcript = eventData.transcript || "";
          if (transcript && conversationState.current.currentAssistantResponse.isActive) {
            if (conversationState.current.currentAssistantResponse.audioTranscriptBuffer.length < transcript.length) {
              conversationState.current.currentAssistantResponse.audioTranscriptBuffer = transcript;
            }
          }
        }

        // 4️⃣ 文字增量事件
        const TEXT_DELTA_EVENTS = [
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "conversation.item.delta",
        ];
        if (TEXT_DELTA_EVENTS.some((ev) => eventType.includes(ev))) {
          const delta = eventData.delta || eventData.text || "";
          if (delta && conversationState.current.currentAssistantResponse.isActive) {
            conversationState.current.currentAssistantResponse.textBuffer += delta;
            console.log(`📝 Added text delta (${delta.length} chars)`);
          }
        }

        // 5️⃣ 文字完成事件
        const TEXT_DONE_EVENTS = ["response.text.done", "response.output_text.done", "output_text.done"];
        if (TEXT_DONE_EVENTS.some((ev) => eventType.includes(ev))) {
          const completedText = eventData.text || "";
          if (completedText && conversationState.current.currentAssistantResponse.isActive) {
            if (conversationState.current.currentAssistantResponse.textBuffer.length < completedText.length) {
              console.log("🔄 Updating buffer with complete text");
              conversationState.current.currentAssistantResponse.textBuffer = completedText;
            }
          }
        }

        // 6️⃣ 內容部分完成
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          if (part?.type === "text" && part.text && conversationState.current.currentAssistantResponse.isActive) {
            if (!conversationState.current.currentAssistantResponse.textBuffer) {
              console.log("🆘 Using text from content_part.done as fallback");
              conversationState.current.currentAssistantResponse.textBuffer = part.text;
            }
          }
        }

        // 7️⃣ 助手回應完成 - 配對記錄
        const RESPONSE_DONE_EVENTS = ["response.done", "response.completed"];
        if (RESPONSE_DONE_EVENTS.includes(eventType)) {
          console.log("🏁 Assistant response completed");

          const assistantResponse = conversationState.current.currentAssistantResponse;
          let finalText = assistantResponse.textBuffer.trim();

          // 文字提取 fallback 邏輯
          if (!finalText) {
            console.warn("⚠️ Text buffer empty, trying fallback extraction");
            if (assistantResponse.audioTranscriptBuffer.trim()) {
              finalText = assistantResponse.audioTranscriptBuffer.trim();
              console.log("🎵 Using audio transcript as primary text");
            }
            if (!finalText) {
              const response = eventData.response;
              if (response?.output) {
                finalText = extractTextFromOutput(response.output);
                if (finalText) {
                  console.log("📦 Extracted from response.output");
                }
              }
            }
            if (!finalText) {
              finalText = (eventData.text || eventData.content || "").trim();
              if (finalText) {
                console.log("🔍 Extracted from event data");
              }
            }
          }

          if (finalText) {
            const assistantMsg = {
              content: finalText,
              eventId: assistantResponse.responseId || eventData.response?.id || eventData.id || `assistant_${Date.now()}`,
              timestamp: Date.now()
            };

            // 🌟 關鍵改動：配對記錄
            if (conversationState.current.currentUserMessage) {
              // 有配對的用戶訊息，一起記錄
              logConversationPair(conversationState.current.currentUserMessage, assistantMsg);
              conversationState.current.currentUserMessage = null; // 清除已配對的用戶訊息
            } else {
              // 沒有配對的用戶訊息，單獨記錄助手回應
              console.warn("⚠️ Assistant response without paired user message");
              reallyPostLog({ 
                role: "assistant", 
                content: finalText, 
                eventId: assistantMsg.eventId,
                timestamp: assistantMsg.timestamp
              }).catch((error) => {
                console.error("💥 Error logging orphaned assistant response:", error);
              });
            }
          } else {
            console.error("❌ No assistant text found after all fallback attempts!");
            postLog({
              role: "system",
              content: `[ERROR] Assistant response completed but no text extracted. Event: ${eventType}`,
              eventId: `error_${Date.now()}`,
            });
          }

          // 重置助手回應狀態
          conversationState.current.currentAssistantResponse = {
            isActive: false,
            responseId: null,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: 0,
          };
        }

        // 8️⃣ 麥克風狀態
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("🎤 User started speaking");
        }
        if (["input_audio_buffer.speech_stopped", "input_audio_buffer.committed"].includes(eventType)) {
          setIsListening(false);
          console.log("🎤 User stopped speaking");
        }

        // 9️⃣ 錯誤處理
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
          postLog({
            role: "system",
            content: `[REALTIME ERROR] ${JSON.stringify(eventData).slice(0, 500)}`,
            eventId: eventData?.event_id || `rt_error_${Date.now()}`,
          });
        }

        // 🔍 調試：記錄未知事件
        const KNOWN_EVENTS = [
          "session.created",
          "session.updated",
          "input_audio_buffer.speech_started",
          "input_audio_buffer.speech_stopped",
          "input_audio_buffer.committed",
          "conversation.item.input_audio_transcription.completed",
          "conversation.item.input_audio_transcription.failed",
          "conversation.item.created",
          "response.created",
          "response.content_part.added",
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "response.text.done",
          "response.output_text.done",
          "output_text.done",
          "response.content_part.done",
          "response.done",
          "response.completed",
          "response.audio_transcript.delta",
          "response.audio_transcript.done",
          "response.audio.done",
          "response.output_item.done",
          "rate_limits.updated",
          "output_audio_buffer.stopped",
          "input_audio_buffer.cleared",
        ];

        if (!KNOWN_EVENTS.includes(eventType)) {
          console.log("🔍 Unknown event:", eventType, eventData);
        }
      });

      // 創建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });

      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);

    // 重置對話狀態
    conversationState.current = {
      currentUserMessage: null,
      currentAssistantResponse: {
        isActive: false,
        responseId: null,
        textBuffer: "",
        audioTranscriptBuffer: "",
        startTime: 0,
      },
      conversationPairs: [],
    };
    loggedEventIds.current.clear();
    pendingLogsRef.current.length = 0;
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === " " + selectedAgentName || a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;

    console.log("💬 Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 🌟 文字訊息也加入配對系統
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    conversationState.current.currentUserMessage = {
      content: textToSend,
      eventId,
      timestamp: Date.now()
    };

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("🎤 PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("🎤 PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI 營養師</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 0825 add emoji feedback logs-daily-app-transcript-report_html

/*
"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

// ✅ 新增：統一日誌角色型別（含 feedback）
type LogRole = "user" | "assistant" | "system" | "feedback";

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  // ⭐️ 本地記錄：每個 assistant 訊息的評分（eventId -> 0/20/50/70/100）
  const [ratingsByTargetId, setRatingsByTargetId] = useState<Record<string, number>>({});

  // ⭐️ 送出評分：UI 顯示表情；後端收到數字
  function sendSatisfactionRating(targetEventId: string, rating: number) {
    const payloadContent = `[RATING] target=${targetEventId} value=${rating}`;
    const feedbackId = `feedback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    reallyPostLog({
      role: "feedback",
      content: payloadContent,     // 後端只看數字與 target，表情只在 UI 顯示
      eventId: feedbackId,
      timestamp: Date.now(),
      rating,
      targetEventId
    }).then(() => {
      setRatingsByTargetId(prev => ({ ...prev, [targetEventId]: rating }));
    }).catch(err => console.error("💥 Error posting rating:", err));
  }

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 對話管理狀態 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");

  // 🔄 新的對話管理系統
  const conversationState = useRef({
    currentUserMessage: null as { content: string; eventId: string; timestamp: number } | null,
    currentAssistantResponse: {
      isActive: false,
      responseId: null as string | null,
      textBuffer: "",
      audioTranscriptBuffer: "",
      startTime: 0,
    },
    conversationPairs: [] as Array<{
      user: { content: string; eventId: string; timestamp: number };
      assistant: { content: string; eventId: string; timestamp: number } | null;
      pairId: string;
    }>,
  });

  // 防重複記錄
  const loggedEventIds = useRef<Set<string>>(new Set());
  // ✅ 放寬 pending 佇列的型別，支援 feedback 與評分欄位
  const pendingLogsRef = useRef<
    Array<{
      role: LogRole;
      content: string;
      eventId?: string;
      pairId?: string;
      timestamp?: number;
      rating?: number;         // 可選：滿意度數字（0/20/50/70/100）
      targetEventId?: string;  // 可選：被評分的 assistant 訊息 ID
    }>
  >([]);

  // 🆕 對話配對日誌函數
  function logConversationPair(
    userMsg: { content: string; eventId: string; timestamp: number },
    assistantMsg: { content: string; eventId: string; timestamp: number }
  ) {
    const pairId = `pair_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // 先記錄用戶訊息
    reallyPostLog({
      role: "user",
      content: userMsg.content,
      eventId: userMsg.eventId,
      pairId,
      timestamp: userMsg.timestamp
    }).then(() => {
      // 再記錄助手回應
      return reallyPostLog({
        role: "assistant",
        content: assistantMsg.content,
        eventId: assistantMsg.eventId,
        pairId,
        timestamp: assistantMsg.timestamp
      });
    }).then(() => {
      console.log(`📝 Logged conversation pair: Q(${userMsg.content.slice(0, 30)}...) -> A(${assistantMsg.content.slice(0, 30)}...)`);
    }).catch((error) => {
      console.error("💥 Error logging conversation pair:", error);
    });
  }

  // 🔧 更新的 reallyPostLog 函數（接受 LogRole 與評分欄位）
  async function reallyPostLog(log: {
    role: LogRole;
    content: string;
    eventId?: string;
    pairId?: string;
    timestamp?: number;
    rating?: number;          // 可選
    targetEventId?: string;   // 可選
  }) {
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);

    const uid = userId || "unknown";
    const sid = sessionId || "unknown";
    const payload = {
      ...log,
      userId: uid,
      sessionId: sid,
      eventId,
      timestamp: log.timestamp || Date.now()
    };

    try {
      const res = await fetch("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!res.ok) {
        console.error("❌ Log API failed:", res.status, res.statusText);
      } else {
        console.log("✅ Log posted:", {
          role: log.role,
          eventId,
          pairId: log.pairId,
          preview: log.content.slice(0, 100) + (log.content.length > 100 ? "..." : ""),
          uid,
          sid,
        });
      }
    } catch (e) {
      console.error("💥 postLog failed:", e);
      pendingLogsRef.current.push({ ...log, eventId });
    }
  }

  // 保留原本的 postLog（用於系統訊息）—型別也放寬到 LogRole
  function postLog(log: {
    role: LogRole;
    content: string;
    eventId?: string;
    pairId?: string;
    timestamp?: number;
    rating?: number;
    targetEventId?: string;
  }) {
    if (!log.content?.trim()) {
      console.warn("🚫 postLog skipped: empty content");
      return;
    }
    if (!log.eventId) {
      log.eventId = `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    if (loggedEventIds.current.has(log.eventId)) {
      console.warn("🔄 Duplicate log prevented (pre-flight):", log.eventId);
      return;
    }
    reallyPostLog(log).catch((error) => {
      console.error("💥 Error in postLog:", error);
    });
  }

  // 佇列 flush
  useEffect(() => {
    const flush = async () => {
      if (pendingLogsRef.current.length === 0) return;
      console.log(`🚀 Flushing pending logs queue: ${pendingLogsRef.current.length} items`);
      const queue = [...pendingLogsRef.current];
      pendingLogsRef.current.length = 0;
      for (const log of queue) {
        await reallyPostLog(log);
      }
    };
    flush();

    const onOnline = () => flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [userId, sessionId]);

  // 輔助函數：從 output 數組提取文字
  function extractTextFromOutput(output: any): string {
    let text = "";
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item?.type === "text" && item.text) {
          text += item.text;
        } else if (item?.content) {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          for (const contentItem of content) {
            if (contentItem?.type === "text" && contentItem.text) {
              text += contentItem.text;
            } else if (contentItem?.type === "audio" && contentItem.transcript) {
              console.log("🎵 Found audio transcript in output:", contentItem.transcript);
              text += contentItem.transcript;
            }
          }
        }
      }
    }
    return text;
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 設置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });

      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });

      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 重構的事件處理邏輯 ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("📨 Event:", eventType);

        // 1️⃣ 用戶語音輸入完成
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const raw = eventData.transcript || eventData.text || "";
          const normalized = raw && raw.trim() && raw.trim() !== "\n" ? raw.trim() : "[inaudible]";
          const eventId = eventData.item_id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          console.log("🗣️ User speech completed:", normalized);

          // 暫存用戶訊息，等待助手回應完成後一起記錄
          conversationState.current.currentUserMessage = {
            content: normalized,
            eventId,
            timestamp: Date.now()
          };
        }

        // 1.1 補捉 item.created（語音轉錄）
        if (eventType === "conversation.item.created") {
          const item = eventData.item;
          if (item?.role === "user" && Array.isArray(item.content)) {
            const transcripts = item.content
              .map((c: any) => c?.transcript)
              .filter(Boolean) as string[];
            const joined = transcripts.join("").trim();
            if (joined && !conversationState.current.currentUserMessage) {
              console.log("🗣️ User speech (created->transcript):", joined);
              conversationState.current.currentUserMessage = {
                content: joined,
                eventId: item.id,
                timestamp: Date.now()
              };
            }
          }
        }

        // 1.2 STT 失敗記錄（系統訊息，直接記錄）
        if (eventType === "conversation.item.input_audio_transcription.failed") {
          const reason = eventData?.error || "unknown";
          postLog({
            role: "system",
            content: `[STT FAILED] ${String(reason).slice(0, 200)}`,
            eventId: eventData.item_id || `stt_fail_${Date.now()}`,
          });
        }

        // 2️⃣ 助手回應開始
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          console.log("🤖 Assistant response started:", responseId);
          conversationState.current.currentAssistantResponse = {
            isActive: true,
            responseId,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: Date.now(),
          };
        }

        // 3️⃣ 音頻轉錄增量
        if (eventType === "response.audio_transcript.delta") {
          const delta = eventData.delta || "";
          if (delta && conversationState.current.currentAssistantResponse.isActive) {
            conversationState.current.currentAssistantResponse.audioTranscriptBuffer += delta;
            console.log(`🎵 Added audio transcript delta (${delta.length} chars)`);
          }
        }
        if (eventType === "response.audio_transcript.done") {
          const transcript = eventData.transcript || "";
          if (transcript && conversationState.current.currentAssistantResponse.isActive) {
            if (conversationState.current.currentAssistantResponse.audioTranscriptBuffer.length < transcript.length) {
              conversationState.current.currentAssistantResponse.audioTranscriptBuffer = transcript;
            }
          }
        }

        // 4️⃣ 文字增量事件
        const TEXT_DELTA_EVENTS = [
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "conversation.item.delta",
        ];
        if (TEXT_DELTA_EVENTS.some((ev) => eventType.includes(ev))) {
          const delta = eventData.delta || eventData.text || "";
          if (delta && conversationState.current.currentAssistantResponse.isActive) {
            conversationState.current.currentAssistantResponse.textBuffer += delta;
            console.log(`📝 Added text delta (${delta.length} chars)`);
          }
        }

        // 5️⃣ 文字完成事件
        const TEXT_DONE_EVENTS = ["response.text.done", "response.output_text.done", "output_text.done"];
        if (TEXT_DONE_EVENTS.some((ev) => eventType.includes(ev))) {
          const completedText = eventData.text || "";
          if (completedText && conversationState.current.currentAssistantResponse.isActive) {
            if (conversationState.current.currentAssistantResponse.textBuffer.length < completedText.length) {
              console.log("🔄 Updating buffer with complete text");
              conversationState.current.currentAssistantResponse.textBuffer = completedText;
            }
          }
        }

        // 6️⃣ 內容部分完成
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          if (part?.type === "text" && part.text && conversationState.current.currentAssistantResponse.isActive) {
            if (!conversationState.current.currentAssistantResponse.textBuffer) {
              console.log("🆘 Using text from content_part.done as fallback");
              conversationState.current.currentAssistantResponse.textBuffer = part.text;
            }
          }
        }

        // 7️⃣ 助手回應完成 - 配對記錄
        const RESPONSE_DONE_EVENTS = ["response.done", "response.completed"];
        if (RESPONSE_DONE_EVENTS.includes(eventType)) {
          console.log("🏁 Assistant response completed");

          const assistantResponse = conversationState.current.currentAssistantResponse;
          let finalText = assistantResponse.textBuffer.trim();

          // 文字提取 fallback 邏輯
          if (!finalText) {
            console.warn("⚠️ Text buffer empty, trying fallback extraction");
            if (assistantResponse.audioTranscriptBuffer.trim()) {
              finalText = assistantResponse.audioTranscriptBuffer.trim();
              console.log("🎵 Using audio transcript as primary text");
            }
            if (!finalText) {
              const response = eventData.response;
              if (response?.output) {
                finalText = extractTextFromOutput(response.output);
                if (finalText) {
                  console.log("📦 Extracted from response.output");
                }
              }
            }
            if (!finalText) {
              finalText = (eventData.text || eventData.content || "").trim();
              if (finalText) {
                console.log("🔍 Extracted from event data");
              }
            }
          }

          if (finalText) {
            const assistantMsg = {
              content: finalText,
              eventId: assistantResponse.responseId || eventData.response?.id || eventData.id || `assistant_${Date.now()}`,
              timestamp: Date.now()
            };

            // 🌟 關鍵改動：配對記錄
            if (conversationState.current.currentUserMessage) {
              // 有配對的用戶訊息，一起記錄
              logConversationPair(conversationState.current.currentUserMessage, assistantMsg);
              conversationState.current.currentUserMessage = null; // 清除已配對的用戶訊息
            } else {
              // 沒有配對的用戶訊息，單獨記錄助手回應
              console.warn("⚠️ Assistant response without paired user message");
              reallyPostLog({
                role: "assistant",
                content: finalText,
                eventId: assistantMsg.eventId,
                timestamp: assistantMsg.timestamp
              }).catch((error) => {
                console.error("💥 Error logging orphaned assistant response:", error);
              });
            }
          } else {
            console.error("❌ No assistant text found after all fallback attempts!");
            postLog({
              role: "system",
              content: `[ERROR] Assistant response completed but no text extracted. Event: ${eventType}`,
              eventId: `error_${Date.now()}`,
            });
          }

          // 重置助手回應狀態
          conversationState.current.currentAssistantResponse = {
            isActive: false,
            responseId: null,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: 0,
          };
        }

        // 8️⃣ 麥克風狀態
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
          console.log("🎤 User started speaking");
        }
        if (["input_audio_buffer.speech_stopped", "input_audio_buffer.committed"].includes(eventType)) {
          setIsListening(false);
          console.log("🎤 User stopped speaking");
        }

        // 9️⃣ 錯誤處理
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
          postLog({
            role: "system",
            content: `[REALTIME ERROR] ${JSON.stringify(eventData).slice(0, 500)}`,
            eventId: eventData?.event_id || `rt_error_${Date.now()}`,
          });
        }

        // 🔍 調試：記錄未知事件
        const KNOWN_EVENTS = [
          "session.created",
          "session.updated",
          "input_audio_buffer.speech_started",
          "input_audio_buffer.speech_stopped",
          "input_audio_buffer.committed",
          "conversation.item.input_audio_transcription.completed",
          "conversation.item.input_audio_transcription.failed",
          "conversation.item.created",
          "response.created",
          "response.content_part.added",
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "response.text.done",
          "response.output_text.done",
          "output_text.done",
          "response.content_part.done",
          "response.done",
          "response.completed",
          "response.audio_transcript.delta",
          "response.audio_transcript.done",
          "response.audio.done",
          "response.output_item.done",
          "rate_limits.updated",
          "output_audio_buffer.stopped",
          "input_audio_buffer.cleared",
        ];

        if (!KNOWN_EVENTS.includes(eventType)) {
          console.log("🔍 Unknown event:", eventType, eventData);
        }
      });

      // 創建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      // 0924 ---> modify the model from 4o to gpt-5 ----> const model = "gpt-4o-realtime-preview-2024-12-17";
      const model = "gpt-realtime";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });

      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);

    // 重置對話狀態
    conversationState.current = {
      currentUserMessage: null,
      currentAssistantResponse: {
        isActive: false,
        responseId: null,
        textBuffer: "",
        audioTranscriptBuffer: "",
        startTime: 0,
      },
      conversationPairs: [],
    };
    loggedEventIds.current.clear();
    pendingLogsRef.current.length = 0;
  }

  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === " " + selectedAgentName || a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = currentAgent?.instructions || "";
    const tools = currentAgent?.tools || "";

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };
    sendClientEvent(sessionUpdateEvent);
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if ((mostRecentAssistantMessage as any).status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;

    console.log("💬 Sending text message:", textToSend);
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    // 🌟 文字訊息也加入配對系統
    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    conversationState.current.currentUserMessage = {
      content: textToSend,
      eventId,
      timestamp: Date.now()
    };

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    console.log("🎤 PTT button pressed down");
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    console.log("🎤 PTT button released");
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      console.log("打斷 ChatGPT 講話");
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
    console.log(`切換到${newMode ? "PTT" : "VAD"}模式`);
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/Weider_logo_1.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>李多慧個性Testing</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          onRate={sendSatisfactionRating}
          ratingsByTargetId={ratingsByTargetId}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 1015 adding vector store and gpt-realtime-mini model
/*
"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

// ✅ 統一日誌角色型別（含 feedback）
type LogRole = "user" | "assistant" | "system" | "feedback";


function extractFileCitationsFromOutput(
  output: any
): Array<{ file_id?: string; vector_store_id?: string; quote?: string }> {
  const citations: Array<{ file_id?: string; vector_store_id?: string; quote?: string }> = [];
  const list = Array.isArray(output) ? output : [];

  for (const item of list) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        const annotations = part?.annotations || [];
        if (Array.isArray(annotations)) {
          for (const ann of annotations) {
            if (
              (ann?.type && String(ann.type).toLowerCase().includes("file")) ||
              ann?.file_id ||
              ann?.vector_store_id
            ) {
              citations.push({
                file_id: ann.file_id,
                vector_store_id: ann.vector_store_id,
                quote: ann.quote,
              });
            }
          }
        }
      }
    }
    if (item?.type === "file_search_call") {
      citations.push({ vector_store_id: item?.vector_store_id });
    }
  }

  return citations;
}

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(null);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  // ⭐️ 本地記錄：每個 assistant 訊息的評分（eventId -> 0/20/50/70/100）
  const [ratingsByTargetId, setRatingsByTargetId] = useState<Record<string, number>>({});

  // ⭐️ 送出評分
  function sendSatisfactionRating(targetEventId: string, rating: number) {
    const payloadContent = `[RATING] target=${targetEventId} value=${rating}`;
    const feedbackId = `feedback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    reallyPostLog({
      role: "feedback",
      content: payloadContent,
      eventId: feedbackId,
      timestamp: Date.now(),
      rating,
      targetEventId
    }).then(() => {
      setRatingsByTargetId(prev => ({ ...prev, [targetEventId]: rating }));
    }).catch(err => console.error("💥 Error posting rating:", err));
  }

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 對話管理狀態 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");

  // 🔄 新的對話管理系統
  const conversationState = useRef({
    currentUserMessage: null as { content: string; eventId: string; timestamp: number } | null,
    currentAssistantResponse: {
      isActive: false,
      responseId: null as string | null,
      textBuffer: "",
      audioTranscriptBuffer: "",
      startTime: 0,
    },
    conversationPairs: [] as Array<{
      user: { content: string; eventId: string; timestamp: number };
      assistant: { content: string; eventId: string; timestamp: number } | null;
      pairId: string;
    }>,
  });

  // 防重複記錄
  const loggedEventIds = useRef<Set<string>>(new Set());
  const pendingLogsRef = useRef<
    Array<{
      role: LogRole;
      content: string;
      eventId?: string;
      pairId?: string;
      timestamp?: number;
      rating?: number;
      targetEventId?: string;
    }>
  >([]);

  // 🆕 對話配對日誌函數
  function logConversationPair(
    userMsg: { content: string; eventId: string; timestamp: number },
    assistantMsg: { content: string; eventId: string; timestamp: number }
  ) {
    const pairId = `pair_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    reallyPostLog({
      role: "user",
      content: userMsg.content,
      eventId: userMsg.eventId,
      pairId,
      timestamp: userMsg.timestamp
    }).then(() => {
      return reallyPostLog({
        role: "assistant",
        content: assistantMsg.content,
        eventId: assistantMsg.eventId,
        pairId,
        timestamp: assistantMsg.timestamp
      });
    }).then(() => {
      console.log(`📝 Logged conversation pair: Q(${userMsg.content.slice(0, 30)}...) -> A(${assistantMsg.content.slice(0, 30)}...)`);
    }).catch((error) => {
      console.error("💥 Error logging conversation pair:", error);
    });
  }

  // 🔧 更新的 reallyPostLog 函數
  async function reallyPostLog(log: {
    role: LogRole;
    content: string;
    eventId?: string;
    pairId?: string;
    timestamp?: number;
    rating?: number;
    targetEventId?: string;
  }) {
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);

    const uid = userId || "unknown";
    const sid = sessionId || "unknown";
    const payload = {
      ...log,
      userId: uid,
      sessionId: sid,
      eventId,
      timestamp: log.timestamp || Date.now()
    };

    try {
      const res = await fetch("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!res.ok) {
        console.error("❌ Log API failed:", res.status, res.statusText);
      } else {
        console.log("✅ Log posted:", {
          role: log.role,
          eventId,
          pairId: log.pairId,
          preview: log.content.slice(0, 100) + (log.content.length > 100 ? "..." : ""),
          uid,
          sid,
        });
      }
    } catch (e) {
      console.error("💥 postLog failed:", e);
      pendingLogsRef.current.push({ ...log, eventId });
    }
  }

  // 保留原本的 postLog
  function postLog(log: {
    role: LogRole;
    content: string;
    eventId?: string;
    pairId?: string;
    timestamp?: number;
    rating?: number;
    targetEventId?: string;
  }) {
    if (!log.content?.trim()) {
      console.warn("🚫 postLog skipped: empty content");
      return;
    }
    if (!log.eventId) {
      log.eventId = `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    if (loggedEventIds.current.has(log.eventId)) {
      console.warn("🔄 Duplicate log prevented (pre-flight):", log.eventId);
      return;
    }
    reallyPostLog(log).catch((error) => {
      console.error("💥 Error in postLog:", error);
    });
  }

  // 佇列 flush
  useEffect(() => {
    const flush = async () => {
      if (pendingLogsRef.current.length === 0) return;
      console.log(`🚀 Flushing pending logs queue: ${pendingLogsRef.current.length} items`);
      const queue = [...pendingLogsRef.current];
      pendingLogsRef.current.length = 0;
      for (const log of queue) {
        await reallyPostLog(log);
      }
    };
    flush();

    const onOnline = () => flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [userId, sessionId]);

  // 輔助：從 output 取文字
  function extractTextFromOutput(output: any): string {
    let text = "";
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item?.type === "text" && item.text) {
          text += item.text;
        } else if (item?.content) {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          for (const contentItem of content) {
            if (contentItem?.type === "text" && contentItem.text) {
              text += contentItem.text;
            } else if (contentItem?.type === "audio" && contentItem.transcript) {
              console.log("🎵 Found audio transcript in output:", contentItem.transcript);
              text += contentItem.transcript;
            } else if ((contentItem?.type === "output_text" || contentItem?.type === "text") && contentItem?.text) {
              text += contentItem.text;
            }
          }
        }
      }
    }
    return text;
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 設置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });

      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });

      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 事件處理（含 citations 抽取） ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("📨 Event:", eventType);

        // 1️⃣ 用戶語音輸入完成
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const raw = eventData.transcript || eventData.text || "";
          const normalized = raw && raw.trim() && raw.trim() !== "\n" ? raw.trim() : "[inaudible]";
          const eventId = eventData.item_id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          conversationState.current.currentUserMessage = {
            content: normalized,
            eventId,
            timestamp: Date.now()
          };
        }

        // 1.1 補捉 item.created（語音轉錄）
        if (eventType === "conversation.item.created") {
          const item = eventData.item;
          if (item?.role === "user" && Array.isArray(item.content)) {
            const transcripts = item.content
              .map((c: any) => c?.transcript)
              .filter(Boolean) as string[];
            const joined = transcripts.join("").trim();
            if (joined && !conversationState.current.currentUserMessage) {
              conversationState.current.currentUserMessage = {
                content: joined,
                eventId: item.id,
                timestamp: Date.now()
              };
            }
          }
        }

        // 1.2 STT 失敗記錄
        if (eventType === "conversation.item.input_audio_transcription.failed") {
          const reason = eventData?.error || "unknown";
          postLog({
            role: "system",
            content: `[STT FAILED] ${String(reason).slice(0, 200)}`,
            eventId: eventData.item_id || `stt_fail_${Date.now()}`,
          });
        }

        // 2️⃣ 助手回應開始
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          conversationState.current.currentAssistantResponse = {
            isActive: true,
            responseId,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: Date.now(),
          };
        }

        // 3️⃣ 音頻轉錄增量
        if (eventType === "response.audio_transcript.delta") {
          const delta = eventData.delta || "";
          if (delta && conversationState.current.currentAssistantResponse.isActive) {
            conversationState.current.currentAssistantResponse.audioTranscriptBuffer += delta;
          }
        }
        if (eventType === "response.audio_transcript.done") {
          const transcript = eventData.transcript || "";
          if (transcript && conversationState.current.currentAssistantResponse.isActive) {
            if (conversationState.current.currentAssistantResponse.audioTranscriptBuffer.length < transcript.length) {
              conversationState.current.currentAssistantResponse.audioTranscriptBuffer = transcript;
            }
          }
        }

        // 4️⃣ 文字增量事件
        const TEXT_DELTA_EVENTS = [
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "conversation.item.delta",
        ];
        if (TEXT_DELTA_EVENTS.some((ev) => eventType.includes(ev))) {
          const delta = eventData.delta || eventData.text || "";
          if (delta && conversationState.current.currentAssistantResponse.isActive) {
            conversationState.current.currentAssistantResponse.textBuffer += delta;
          }
        }

        // 5️⃣ 文字完成事件
        const TEXT_DONE_EVENTS = ["response.text.done", "response.output_text.done", "output_text.done"];
        if (TEXT_DONE_EVENTS.some((ev) => eventType.includes(ev))) {
          const completedText = eventData.text || "";
          if (completedText && conversationState.current.currentAssistantResponse.isActive) {
            if (conversationState.current.currentAssistantResponse.textBuffer.length < completedText.length) {
              conversationState.current.currentAssistantResponse.textBuffer = completedText;
            }
          }
        }

        // 6️⃣ 內容部分完成
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          if (part?.type === "text" && part.text && conversationState.current.currentAssistantResponse.isActive) {
            if (!conversationState.current.currentAssistantResponse.textBuffer) {
              conversationState.current.currentAssistantResponse.textBuffer = part.text;
            }
          }
        }

        // 7️⃣ 助手回應完成 - 配對記錄 + citation 抽取
        const RESPONSE_DONE_EVENTS = ["response.done", "response.completed"];
        if (RESPONSE_DONE_EVENTS.includes(eventType)) {
          const assistantResponse = conversationState.current.currentAssistantResponse;
          let finalText = assistantResponse.textBuffer.trim();

          if (!finalText) {
            if (assistantResponse.audioTranscriptBuffer.trim()) {
              finalText = assistantResponse.audioTranscriptBuffer.trim();
            }
            if (!finalText) {
              const response = eventData.response;
              if (response?.output) {
                finalText = extractTextFromOutput(response.output);
              }
            }
            if (!finalText) {
              finalText = (eventData.text || eventData.content || "").trim();
            }
          }

          // 🔎 取 citations（若使用了 file_search）
          try {
            const citations = extractFileCitationsFromOutput(eventData?.response?.output);
            if (citations?.length) {
              postLog({
                role: "system",
                content: `[CITATIONS] ${JSON.stringify(citations).slice(0, 1000)}`,
              });
            }
          } catch (err) {
            console.warn("Citation extraction failed:", err);
          }

          if (finalText) {
            const assistantMsg = {
              content: finalText,
              eventId: assistantResponse.responseId || eventData.response?.id || eventData.id || `assistant_${Date.now()}`,
              timestamp: Date.now()
            };

            if (conversationState.current.currentUserMessage) {
              logConversationPair(conversationState.current.currentUserMessage, assistantMsg);
              conversationState.current.currentUserMessage = null;
            } else {
              reallyPostLog({
                role: "assistant",
                content: finalText,
                eventId: assistantMsg.eventId,
                timestamp: assistantMsg.timestamp
              }).catch((error) => {
                console.error("💥 Error logging orphaned assistant response:", error);
              });
            }
          } else {
            postLog({
              role: "system",
              content: `[ERROR] Assistant response completed but no text extracted. Event: ${eventType}`,
              eventId: `error_${Date.now()}`,
            });
          }

          conversationState.current.currentAssistantResponse = {
            isActive: false,
            responseId: null,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: 0,
          };
        }

        // 8️⃣ 麥克風狀態
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
        }
        if (["input_audio_buffer.speech_stopped", "input_audio_buffer.committed"].includes(eventType)) {
          setIsListening(false);
        }

        // 9️⃣ 錯誤處理
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
          postLog({
            role: "system",
            content: `[REALTIME ERROR] ${JSON.stringify(eventData).slice(0, 500)}`,
            eventId: eventData?.event_id || `rt_error_${Date.now()}`,
          });
        }

        const KNOWN_EVENTS = [
          "session.created",
          "session.updated",
          "input_audio_buffer.speech_started",
          "input_audio_buffer.speech_stopped",
          "input_audio_buffer.committed",
          "conversation.item.input_audio_transcription.completed",
          "conversation.item.input_audio_transcription.failed",
          "conversation.item.created",
          "response.created",
          "response.content_part.added",
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "response.text.done",
          "response.output_text.done",
          "output_text.done",
          "response.content_part.done",
          "response.done",
          "response.completed",
          "response.audio_transcript.delta",
          "response.audio_transcript.done",
          "response.audio.done",
          "response.output_item.done",
          "rate_limits.updated",
          "output_audio_buffer.stopped",
          "input_audio_buffer.cleared",
        ];

        if (!KNOWN_EVENTS.includes(eventType)) {
          console.log("🔍 Unknown event:", eventType, eventData);
        }
      });

      // 創建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-realtime-mini";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });

      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);

    conversationState.current = {
      currentUserMessage: null,
      currentAssistantResponse: {
        isActive: false,
        responseId: null,
        textBuffer: "",
        audioTranscriptBuffer: "",
        startTime: 0,
      },
      conversationPairs: [],
    };
    loggedEventIds.current.clear();
    pendingLogsRef.current.length = 0;
  }

  
  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find((a) => a.name === " " + selectedAgentName || a.name === selectedAgentName);

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = `${
      currentAgent?.instructions || ""
    }

- 當問題需要公司/內部文件或知識庫內容時，請先使用 file_search 檢索向量庫，並在回答中附上來源。`;

    const tools = currentAgent?.tools ?? []; // 👈 僅使用 AgentConfig 內的 tools

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
        tool_choice: "auto",
      },
    };
    sendClientEvent(sessionUpdateEvent, "use agent.tools only");
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) return;
    if ((mostRecentAssistantMessage as any).status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;

    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    conversationState.current.currentUserMessage = {
      content: textToSend,
      eventId,
      timestamp: Date.now()
    };

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div className="text-base flex flex-col bg-gray-100 text-gray-800 relative" style={{ height: "100dvh", maxHeight: "100dvh" }}>
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/aigoasia_logo.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>AI解籤服務</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse" : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={isOutputAudioBufferActive ? "點擊打斷 AI 講話" : isPTTActive ? "點擊切換到持續對話模式" : "持續對話模式"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          onRate={sendSatisfactionRating}
          ratingsByTargetId={ratingsByTargetId}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;*/

// 1223 Testing realtime gpt + gpt5 + file search

"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";

import Transcript from "./components/Transcript";
import Events from "./components/Events";

import { AgentConfig, SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";
import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import useAudioDownload from "./hooks/useAudioDownload";

// ✅ 統一日誌角色型別（含 feedback）
type LogRole = "user" | "assistant" | "system" | "feedback";

/** ✅ 從 Realtime 的 response.output 中提取 citations（檔案引用） */
function extractFileCitationsFromOutput(
  output: any
): Array<{ file_id?: string; vector_store_id?: string; quote?: string }> {
  const citations: Array<{ file_id?: string; vector_store_id?: string; quote?: string }> = [];
  const list = Array.isArray(output) ? output : [];

  for (const item of list) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        const annotations = part?.annotations || [];
        if (Array.isArray(annotations)) {
          for (const ann of annotations) {
            if (
              (ann?.type && String(ann.type).toLowerCase().includes("file")) ||
              ann?.file_id ||
              ann?.vector_store_id
            ) {
              citations.push({
                file_id: ann.file_id,
                vector_store_id: ann.vector_store_id,
                quote: ann.quote,
              });
            }
          }
        }
      }
    }
    if (item?.type === "file_search_call") {
      citations.push({ vector_store_id: item?.vector_store_id });
    }
  }

  return citations;
}

function AppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setSearchParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  const { transcriptItems } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<AgentConfig[] | null>(
    null
  );

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  // ⭐️ 本地記錄：每個 assistant 訊息的評分（eventId -> 0/20/50/70/100）
  const [ratingsByTargetId, setRatingsByTargetId] = useState<Record<string, number>>({});

  // ⭐️ 送出評分
  function sendSatisfactionRating(targetEventId: string, rating: number) {
    const payloadContent = `[RATING] target=${targetEventId} value=${rating}`;
    const feedbackId = `feedback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    reallyPostLog({
      role: "feedback",
      content: payloadContent,
      eventId: feedbackId,
      timestamp: Date.now(),
      rating,
      targetEventId,
    })
      .then(() => {
        setRatingsByTargetId((prev) => ({ ...prev, [targetEventId]: rating }));
      })
      .catch((err) => console.error("💥 Error posting rating:", err));
  }

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(false);
  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [isOutputAudioBufferActive, setIsOutputAudioBufferActive] = useState<boolean>(false);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();

  // ===== 對話管理狀態 =====
  const [userId, setUserId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");

  // 🔄 新的對話管理系統
  const conversationState = useRef({
    currentUserMessage: null as { content: string; eventId: string; timestamp: number } | null,
    currentAssistantResponse: {
      isActive: false,
      responseId: null as string | null,
      textBuffer: "",
      audioTranscriptBuffer: "",
      startTime: 0,
    },
    conversationPairs: [] as Array<{
      user: { content: string; eventId: string; timestamp: number };
      assistant: { content: string; eventId: string; timestamp: number } | null;
      pairId: string;
    }>,
  });

  // 防重複記錄
  const loggedEventIds = useRef<Set<string>>(new Set());

  // ✅ 防止 function_call 因為 response.done/response.completed 重複被處理
  const processedToolCallIds = useRef<Set<string>>(new Set());

  const pendingLogsRef = useRef<
    Array<{
      role: LogRole;
      content: string;
      eventId?: string;
      pairId?: string;
      timestamp?: number;
      rating?: number;
      targetEventId?: string;
    }>
  >([]);

  // 🆕 對話配對日誌函數
  function logConversationPair(
    userMsg: { content: string; eventId: string; timestamp: number },
    assistantMsg: { content: string; eventId: string; timestamp: number }
  ) {
    const pairId = `pair_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    reallyPostLog({
      role: "user",
      content: userMsg.content,
      eventId: userMsg.eventId,
      pairId,
      timestamp: userMsg.timestamp,
    })
      .then(() => {
        return reallyPostLog({
          role: "assistant",
          content: assistantMsg.content,
          eventId: assistantMsg.eventId,
          pairId,
          timestamp: assistantMsg.timestamp,
        });
      })
      .then(() => {
        console.log(
          `📝 Logged conversation pair: Q(${userMsg.content.slice(
            0,
            30
          )}...) -> A(${assistantMsg.content.slice(0, 30)}...)`
        );
      })
      .catch((error) => {
        console.error("💥 Error logging conversation pair:", error);
      });
  }

  // 🔧 更新的 reallyPostLog 函數
  async function reallyPostLog(log: {
    role: LogRole;
    content: string;
    eventId?: string;
    pairId?: string;
    timestamp?: number;
    rating?: number;
    targetEventId?: string;
  }) {
    const eventId = log.eventId || `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (loggedEventIds.current.has(eventId)) {
      console.warn("🔄 Duplicate log prevented:", eventId);
      return;
    }
    loggedEventIds.current.add(eventId);

    const uid = userId || "unknown";
    const sid = sessionId || "unknown";
    const payload = {
      ...log,
      userId: uid,
      sessionId: sid,
      eventId,
      timestamp: log.timestamp || Date.now(),
    };

    try {
      const res = await fetch("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!res.ok) {
        console.error("❌ Log API failed:", res.status, res.statusText);
      } else {
        console.log("✅ Log posted:", {
          role: log.role,
          eventId,
          pairId: log.pairId,
          preview: log.content.slice(0, 100) + (log.content.length > 100 ? "..." : ""),
          uid,
          sid,
        });
      }
    } catch (e) {
      console.error("💥 postLog failed:", e);
      pendingLogsRef.current.push({ ...log, eventId });
    }
  }

  // 保留原本的 postLog
  function postLog(log: {
    role: LogRole;
    content: string;
    eventId?: string;
    pairId?: string;
    timestamp?: number;
    rating?: number;
    targetEventId?: string;
  }) {
    if (!log.content?.trim()) {
      console.warn("🚫 postLog skipped: empty content");
      return;
    }
    if (!log.eventId) {
      log.eventId = `${log.role}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
    if (loggedEventIds.current.has(log.eventId)) {
      console.warn("🔄 Duplicate log prevented (pre-flight):", log.eventId);
      return;
    }
    reallyPostLog(log).catch((error) => {
      console.error("💥 Error in postLog:", error);
    });
  }

  // 佇列 flush
  useEffect(() => {
    const flush = async () => {
      if (pendingLogsRef.current.length === 0) return;
      console.log(`🚀 Flushing pending logs queue: ${pendingLogsRef.current.length} items`);
      const queue = [...pendingLogsRef.current];
      pendingLogsRef.current.length = 0;
      for (const log of queue) {
        await reallyPostLog(log);
      }
    };
    flush();

    const onOnline = () => flush();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [userId, sessionId]);

  // 輔助：從 output 取文字
  function extractTextFromOutput(output: any): string {
    let text = "";
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item?.type === "text" && item.text) {
          text += item.text;
        } else if (item?.content) {
          const content = Array.isArray(item.content) ? item.content : [item.content];
          for (const contentItem of content) {
            if (contentItem?.type === "text" && contentItem.text) {
              text += contentItem.text;
            } else if (contentItem?.type === "audio" && contentItem.transcript) {
              console.log("🎵 Found audio transcript in output:", contentItem.transcript);
              text += contentItem.transcript;
            } else if (
              (contentItem?.type === "output_text" || contentItem?.type === "text") &&
              contentItem?.text
            ) {
              text += contentItem.text;
            }
          }
        }
      }
    }
    return text;
  }

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dataChannel && dataChannel.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dataChannel.send(JSON.stringify(eventObj));
    } else {
      logClientEvent({ attemptedEvent: eventObj.type }, "error.data_channel_not_open");
      console.error("Failed to send message - no data channel available", eventObj);
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
    setIsOutputAudioBufferActive,
  });

  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");
    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      setSearchParam("agentConfig", finalAgentConfig);
      return;
    }
    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";
    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      startSession();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && selectedAgentConfigSet && selectedAgentName) {
      updateSession();
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  async function startSession() {
    if (sessionStatus !== "DISCONNECTED") return;
    await connectToRealtime();
  }

  async function connectToRealtime() {
    setSessionStatus("CONNECTING");
    try {
      logClientEvent({ url: "/api/session" }, "fetch_session_token_request");
      const tokenResponse = await fetch("/api/session");
      const data = await tokenResponse.json();
      logServerEvent(data, "fetch_session_token_response");

      if (data?.userId) {
        setUserId(data.userId);
        console.log("👤 User ID set:", data.userId.substring(0, 8) + "...");
      }
      if (data?.sessionId) {
        setSessionId(data.sessionId);
        console.log("🔗 Session ID set:", data.sessionId.substring(0, 8) + "...");
      }

      if (!data.client_secret?.value) {
        logClientEvent(data, "error.no_ephemeral_key");
        console.error("No ephemeral key provided by the server");
        setSessionStatus("DISCONNECTED");
        return;
      }

      const EPHEMERAL_KEY = data.client_secret.value;

      // WebRTC 設置
      const pc = new RTCPeerConnection();
      peerConnection.current = pc;

      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = isAudioPlaybackEnabled;
      pc.ontrack = (e) => {
        if (audioElement.current) audioElement.current.srcObject = e.streams[0];
      };

      const newMs = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(newMs.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
        setSessionStatus("CONNECTED");
        console.log("🚀 Data channel opened - ready for conversation");
      });

      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
        setSessionStatus("DISCONNECTED");
      });

      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });

      // ★★★ 事件處理（含 citations 抽取 + tool calling） ★★★
      dc.addEventListener("message", (e: MessageEvent) => {
        const eventData: any = JSON.parse(e.data);
        handleServerEventRef.current(eventData);

        const eventType = String(eventData?.type || "");
        console.log("📨 Event:", eventType);

        // 1️⃣ 用戶語音輸入完成
        if (eventType === "conversation.item.input_audio_transcription.completed") {
          const raw = eventData.transcript || eventData.text || "";
          const normalized = raw && raw.trim() && raw.trim() !== "\n" ? raw.trim() : "[inaudible]";
          const eventId = eventData.item_id || `speech_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          conversationState.current.currentUserMessage = {
            content: normalized,
            eventId,
            timestamp: Date.now(),
          };
        }

        // 1.1 補捉 item.created（語音轉錄）
        if (eventType === "conversation.item.created") {
          const item = eventData.item;
          if (item?.role === "user" && Array.isArray(item.content)) {
            const transcripts = item.content.map((c: any) => c?.transcript).filter(Boolean) as string[];
            const joined = transcripts.join("").trim();
            if (joined && !conversationState.current.currentUserMessage) {
              conversationState.current.currentUserMessage = {
                content: joined,
                eventId: item.id,
                timestamp: Date.now(),
              };
            }
          }
        }

        // 1.2 STT 失敗記錄
        if (eventType === "conversation.item.input_audio_transcription.failed") {
          const reason = eventData?.error || "unknown";
          postLog({
            role: "system",
            content: `[STT FAILED] ${String(reason).slice(0, 200)}`,
            eventId: eventData.item_id || `stt_fail_${Date.now()}`,
          });
        }

        // 2️⃣ 助手回應開始
        if (eventType === "response.created") {
          const responseId = eventData.response?.id || eventData.id;
          conversationState.current.currentAssistantResponse = {
            isActive: true,
            responseId,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: Date.now(),
          };
        }

        // 3️⃣ 音頻轉錄增量
        if (eventType === "response.audio_transcript.delta") {
          const delta = eventData.delta || "";
          if (delta && conversationState.current.currentAssistantResponse.isActive) {
            conversationState.current.currentAssistantResponse.audioTranscriptBuffer += delta;
          }
        }
        if (eventType === "response.audio_transcript.done") {
          const transcript = eventData.transcript || "";
          if (transcript && conversationState.current.currentAssistantResponse.isActive) {
            if (conversationState.current.currentAssistantResponse.audioTranscriptBuffer.length < transcript.length) {
              conversationState.current.currentAssistantResponse.audioTranscriptBuffer = transcript;
            }
          }
        }

        // 4️⃣ 文字增量事件
        const TEXT_DELTA_EVENTS = [
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "conversation.item.delta",
        ];
        if (TEXT_DELTA_EVENTS.some((ev) => eventType.includes(ev))) {
          const delta = eventData.delta || eventData.text || "";
          if (delta && conversationState.current.currentAssistantResponse.isActive) {
            conversationState.current.currentAssistantResponse.textBuffer += delta;
          }
        }

        // 5️⃣ 文字完成事件
        const TEXT_DONE_EVENTS = ["response.text.done", "response.output_text.done", "output_text.done"];
        if (TEXT_DONE_EVENTS.some((ev) => eventType.includes(ev))) {
          const completedText = eventData.text || "";
          if (completedText && conversationState.current.currentAssistantResponse.isActive) {
            if (conversationState.current.currentAssistantResponse.textBuffer.length < completedText.length) {
              conversationState.current.currentAssistantResponse.textBuffer = completedText;
            }
          }
        }

        // 6️⃣ 內容部分完成
        if (eventType === "response.content_part.done") {
          const part = eventData.part;
          if (part?.type === "text" && part.text && conversationState.current.currentAssistantResponse.isActive) {
            if (!conversationState.current.currentAssistantResponse.textBuffer) {
              conversationState.current.currentAssistantResponse.textBuffer = part.text;
            }
          }
        }

        // 7️⃣ 助手回應完成 - ✅支援 function_call(web_search) + 配對記錄 + citation 抽取
        const RESPONSE_DONE_EVENTS = ["response.done", "response.completed"];
        if (RESPONSE_DONE_EVENTS.includes(eventType)) {
          // ✅ 7.0：如果這次 response.done 是工具呼叫（function_call），先做工具再回填結果
          const outputItems = eventData?.response?.output || [];
          const functionCalls = Array.isArray(outputItems)
            ? outputItems.filter((it: any) => it?.type === "function_call" && it?.call_id && it?.name)
            : [];

          if (functionCalls.length) {
            // 避免 response.done + response.completed 重複觸發同一個 call
            const callsToProcess = functionCalls.filter((c: any) => !processedToolCallIds.current.has(c.call_id));
            if (callsToProcess.length) {
              callsToProcess.forEach((c: any) => processedToolCallIds.current.add(c.call_id));

              void (async () => {
                try {
                  // 目前先支援 web_search；未來你要擴充其他 function tool，可在這裡加分支
                  for (const call of callsToProcess) {
                    if (call.name !== "web_search") continue;

                    let args: any = {};
                    try {
                      args = typeof call.arguments === "string" ? JSON.parse(call.arguments || "{}") : call.arguments || {};
                    } catch {
                      args = {};
                    }

                    const query = String(args.query || "").trim();
                    const recency_days = Number(args.recency_days || 30);
                    const domains = Array.isArray(args.domains) ? args.domains : undefined;

                    // 小記錄：只記 query，不把整包結果塞進 log（避免太大）
                    postLog({
                      role: "system",
                      content: `[WEB_SEARCH CALL] query="${query}" recency_days=${recency_days}${
                        domains?.length ? ` domains=${JSON.stringify(domains).slice(0, 200)}` : ""
                      }`,
                      eventId: `web_search_call_${call.call_id}`,
                    });

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
                      postLog({
                        role: "system",
                        content: `[WEB_SEARCH ERROR] status=${res.status} ${res.statusText} body=${JSON.stringify(data).slice(0, 300)}`,
                        eventId: `web_search_err_${call.call_id}`,
                      });
                    } else {
                      const cCount = Array.isArray(data?.citations) ? data.citations.length : 0;
                      postLog({
                        role: "system",
                        content: `[WEB_SEARCH OK] citations=${cCount} preview=${String(data?.answer || "").slice(0, 200)}`,
                        eventId: `web_search_ok_${call.call_id}`,
                      });
                    }

                    // 把工具結果回塞給 Realtime（同一個 call_id）
                    sendClientEvent(
                      {
                        type: "conversation.item.create",
                        item: {
                          type: "function_call_output",
                          call_id: call.call_id,
                          output: JSON.stringify(data).slice(0, 20000), // 防止過大
                        },
                      },
                      "(tool output: web_search)"
                    );
                  }

                  // 再觸發一次 response.create，讓模型用工具結果生成最終回答
                  sendClientEvent({ type: "response.create" }, "(trigger response after web_search)");
                } catch (err) {
                  console.error("💥 web_search tool failed:", err);
                  postLog({
                    role: "system",
                    content: `[WEB_SEARCH FAILED] ${String(err).slice(0, 200)}`,
                    eventId: `web_search_fail_${Date.now()}`,
                  });
                }
              })();
            }

            // ⚠️ 這次 done 不要當成 assistant 最終文字，直接結束（保留 currentUserMessage 供下一次回答配對）
            conversationState.current.currentAssistantResponse = {
              isActive: false,
              responseId: null,
              textBuffer: "",
              audioTranscriptBuffer: "",
              startTime: 0,
            };
            return;
          }

          // ✅ 7.1：一般「文字/語音回答」完成，照原本流程記錄
          const assistantResponse = conversationState.current.currentAssistantResponse;
          let finalText = assistantResponse.textBuffer.trim();

          if (!finalText) {
            if (assistantResponse.audioTranscriptBuffer.trim()) {
              finalText = assistantResponse.audioTranscriptBuffer.trim();
            }
            if (!finalText) {
              const response = eventData.response;
              if (response?.output) {
                finalText = extractTextFromOutput(response.output);
              }
            }
            if (!finalText) {
              finalText = (eventData.text || eventData.content || "").trim();
            }
          }

          // 🔎 取 citations（若使用了 file_search）
          try {
            const citations = extractFileCitationsFromOutput(eventData?.response?.output);
            if (citations?.length) {
              postLog({
                role: "system",
                content: `[CITATIONS] ${JSON.stringify(citations).slice(0, 1000)}`,
              });
            }
          } catch (err) {
            console.warn("Citation extraction failed:", err);
          }

          if (finalText) {
            const assistantMsg = {
              content: finalText,
              eventId:
                assistantResponse.responseId ||
                eventData.response?.id ||
                eventData.id ||
                `assistant_${Date.now()}`,
              timestamp: Date.now(),
            };

            if (conversationState.current.currentUserMessage) {
              logConversationPair(conversationState.current.currentUserMessage, assistantMsg);
              conversationState.current.currentUserMessage = null;
            } else {
              reallyPostLog({
                role: "assistant",
                content: finalText,
                eventId: assistantMsg.eventId,
                timestamp: assistantMsg.timestamp,
              }).catch((error) => {
                console.error("💥 Error logging orphaned assistant response:", error);
              });
            }
          } else {
            postLog({
              role: "system",
              content: `[ERROR] Assistant response completed but no text extracted. Event: ${eventType}`,
              eventId: `error_${Date.now()}`,
            });
          }

          conversationState.current.currentAssistantResponse = {
            isActive: false,
            responseId: null,
            textBuffer: "",
            audioTranscriptBuffer: "",
            startTime: 0,
          };
        }

        // 8️⃣ 麥克風狀態
        if (eventType === "input_audio_buffer.speech_started") {
          setIsListening(true);
        }
        if (["input_audio_buffer.speech_stopped", "input_audio_buffer.committed"].includes(eventType)) {
          setIsListening(false);
        }

        // 9️⃣ 錯誤處理
        if (eventType === "error") {
          console.error("❌ Realtime API error:", eventData);
          postLog({
            role: "system",
            content: `[REALTIME ERROR] ${JSON.stringify(eventData).slice(0, 500)}`,
            eventId: eventData?.event_id || `rt_error_${Date.now()}`,
          });
        }

        const KNOWN_EVENTS = [
          "session.created",
          "session.updated",
          "input_audio_buffer.speech_started",
          "input_audio_buffer.speech_stopped",
          "input_audio_buffer.committed",
          "conversation.item.input_audio_transcription.completed",
          "conversation.item.input_audio_transcription.failed",
          "conversation.item.created",
          "response.created",
          "response.content_part.added",
          "response.text.delta",
          "response.output_text.delta",
          "output_text.delta",
          "response.text.done",
          "response.output_text.done",
          "output_text.done",
          "response.content_part.done",
          "response.done",
          "response.completed",
          "response.audio_transcript.delta",
          "response.audio_transcript.done",
          "response.audio.done",
          "response.output_item.done",
          "rate_limits.updated",
          "output_audio_buffer.stopped",
          "input_audio_buffer.cleared",
        ];

        if (!KNOWN_EVENTS.includes(eventType)) {
          console.log("🔍 Unknown event:", eventType, eventData);
        }
      });

      // 創建 WebRTC offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-realtime-mini";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
      });
      await pc.setRemoteDescription({ type: "answer" as RTCSdpType, sdp: await sdpResponse.text() });

      console.log("🎯 WebRTC connection established");
    } catch (err) {
      console.error("💥 Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
      setDataChannel(null);
    }
    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => sender.track && sender.track.stop());
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setSessionStatus("DISCONNECTED");
    setIsListening(false);

    conversationState.current = {
      currentUserMessage: null,
      currentAssistantResponse: {
        isActive: false,
        responseId: null,
        textBuffer: "",
        audioTranscriptBuffer: "",
        startTime: 0,
      },
      conversationPairs: [],
    };
    loggedEventIds.current.clear();
    processedToolCallIds.current.clear();
    pendingLogsRef.current.length = 0;
  }

  /** ✅ 使用 agentConfig tools + 自動補上 web_search（若尚未定義） */
  const updateSession = () => {
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear audio buffer on session update");
    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === " " + selectedAgentName || a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true,
        };

    const instructions = `${
      currentAgent?.instructions || ""
    }

- 當問題需要公司/內部文件或知識庫內容時，請先使用 file_search 檢索向量庫，並在回答中附上來源。
- 當問題需要最新的外部資訊（新聞、價格、政策、版本更新）時，先呼叫 web_search，再用搜尋結果回答並附上來源。`;

    // ✅ web_search function tool（如果 agentConfig 沒定義，就補上）
    const webSearchTool = {
      type: "function",
      name: "web_search",
      description: "Search the public web for up-to-date info and return key points with sources.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          recency_days: { type: "integer", description: "Prefer results within N days", default: 30 },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Optional allowlist of domains, e.g. ['openai.com','who.int']",
          },
        },
        required: ["query"],
      },
    };

    const baseTools = (currentAgent?.tools ?? []) as any[];
    const hasWebSearch = baseTools.some((t) => t?.name === "web_search");
    const tools = hasWebSearch ? baseTools : [...baseTools, webSearchTool];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: "cedar",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
        tool_choice: "auto",
      },
    };
    sendClientEvent(sessionUpdateEvent, "agent.tools + web_search");
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems].reverse().find((item) => item.role === "assistant");
    if (!mostRecentAssistantMessage) return;
    if ((mostRecentAssistantMessage as any).status === "IN_PROGRESS") {
      sendClientEvent({ type: "response.cancel" }, "(cancel due to user interruption)");
    }
    if (isOutputAudioBufferActive) {
      sendClientEvent({ type: "output_audio_buffer.clear" }, "(cancel due to user interruption)");
    }
  };

  const handleSendTextMessage = () => {
    const textToSend = userText.trim();
    if (!textToSend) return;

    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: textToSend }] },
      },
      "(send user text message)"
    );

    const eventId = `text_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    conversationState.current.currentUserMessage = {
      content: textToSend,
      eventId,
      timestamp: Date.now(),
    };

    setUserText("");
    sendClientEvent({ type: "response.create" }, "(trigger response)");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open") return;
    cancelAssistantSpeech();
    setIsPTTUserSpeaking(true);
    setIsListening(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || dataChannel?.readyState !== "open" || !isPTTUserSpeaking) return;
    setIsPTTUserSpeaking(false);
    setIsListening(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const handleMicrophoneClick = () => {
    if (isOutputAudioBufferActive) {
      cancelAssistantSpeech();
      return;
    }
    toggleConversationMode();
  };

  const toggleConversationMode = () => {
    const newMode = !isPTTActive;
    setIsPTTActive(newMode);
    localStorage.setItem("conversationMode", newMode ? "PTT" : "VAD");
  };

  useEffect(() => {
    setIsPTTActive(false);
    localStorage.setItem("conversationMode", "VAD");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");
    else localStorage.setItem("logsExpanded", "false");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElement.current) {
      if (isAudioPlaybackEnabled) {
        audioElement.current.play().catch((err) => console.warn("Autoplay may be blocked by browser:", err));
      } else {
        audioElement.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElement.current?.srcObject) {
      const remoteStream = audioElement.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }
    return () => {
      stopRecording();
    };
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  return (
    <div
      className="text-base flex flex-col bg-gray-100 text-gray-800 relative"
      style={{ height: "100dvh", maxHeight: "100dvh" }}
    >
      <div className="p-3 sm:p-5 text-lg font-semibold flex justify-between items-center flex-shrink-0 border-b border-gray-200">
        <div className="flex items-center cursor-pointer" onClick={() => window.location.reload()}>
          <div>
            <Image src="/aigoasia_logo.png" alt="Weider Logo" width={40} height={40} className="mr-2" />
          </div>
          <div>股市名嘴</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleMicrophoneClick}
            className={`w-12 h-12 rounded-full flex items-center justify-center font-medium transition-all duration-200 relative ${
              isPTTActive
                ? "bg-blue-500 text-white hover:bg-blue-600 shadow-md animate-pulse"
                : "bg-green-500 text-white hover:bg-green-600 shadow-md animate-pulse"
            }`}
            title={
              isOutputAudioBufferActive
                ? "點擊打斷 AI 講話"
                : isPTTActive
                ? "點擊切換到持續對話模式"
                : "持續對話模式"
            }
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
            {!isPTTActive && isListening && !isOutputAudioBufferActive && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-500 rounded-full"></div>
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED" && dataChannel?.readyState === "open"}
          handleTalkButtonDown={handleTalkButtonDown}
          handleTalkButtonUp={handleTalkButtonUp}
          isPTTUserSpeaking={isPTTUserSpeaking}
          isPTTActive={isPTTActive}
          onRate={sendSatisfactionRating}
          ratingsByTargetId={ratingsByTargetId}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>
    </div>
  );
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <div className="text-lg">載入中...</div>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;








