export type SpawnCommand = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'spawn';
  agent: string;
  initialMessage?: string;
};

export type KillCommand = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'kill';
  agentId: string;
};

export type ListCommand = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'list';
};

export type InputCommand = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'input';
  agentId: string;
  text: string;
};

export type ControlCommand = SpawnCommand | KillCommand | ListCommand | InputCommand;

export type SpawnedResponse = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'spawned';
  agentId: string;
  agent: string;
  roomSecret: string;
};

export type OutputResponse = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'output';
  agentId: string;
  tag: 'STATUS' | 'ASK' | 'PICK' | 'DONE' | 'BLOCKED' | 'CHAT';
  text: string;
  options?: string[];
};

export type ExitedResponse = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'exited';
  agentId: string;
  exitCode: number | null;
};

export type ListReplyResponse = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'list-reply';
  agents: Array<{ agentId: string; agent: string; status: string }>;
};

export type ErrorResponse = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'error';
  message: string;
};

export type DaemonStatusResponse = {
  proto: 'hisohiso-ctl';
  v: 1;
  cmd: 'daemon-status';
  message: string;
};

export type ControlResponse = SpawnedResponse | OutputResponse | ExitedResponse | ListReplyResponse | ErrorResponse | DaemonStatusResponse;

export const encodeControlMessage = (msg: ControlCommand | ControlResponse): string => {
  return JSON.stringify(msg);
};

export const decodeControlMessage = (text: string): ControlCommand | ControlResponse | null => {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.proto === 'hisohiso-ctl') {
      return parsed as ControlCommand | ControlResponse;
    }
  } catch {
    // not a control message
  }
  return null;
};
