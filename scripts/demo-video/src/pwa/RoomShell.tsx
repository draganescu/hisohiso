// Markup lifted from app/src/pages/RoomController.tsx — chat shell.
// Header + message list + floating Compose button + optional Join queue modal.
//
// The PWA's real composer is a full-screen modal opened by a floating black
// "Compose" button. The static shell we use here shows that button at rest,
// matching what the user sees when they're not typing.

import { ReactNode } from 'react';

export type ChatMsg =
  | {
      type: 'text';
      id: string;
      who: 'me' | 'them';
      sender?: string;
      content: string;
    }
  | {
      type: 'system';
      id: string;
      content: string;
      timestamp: string;
    };

export type Knock = {
  id: string;
  note: string;
  when: string;
};

type Props = {
  channelColor?: string;
  channelName?: string;
  handle?: string;
  badgeCount?: number;
  messages?: ChatMsg[];
  showQueue?: boolean;
  knocks?: Knock[];
  bellRingOverlay?: ReactNode;
  composerLabel?: 'Compose' | 'Continue reply';
  hideComposer?: boolean;
};

export const RoomShell = ({
  channelColor = '#0a7d3f',
  channelName = 'launch crew',
  handle = 'andrei',
  badgeCount = 0,
  messages = [],
  showQueue = false,
  knocks = [],
  bellRingOverlay,
  composerLabel = 'Compose',
  hideComposer = false,
}: Props) => {
  return (
    <div className="app-shell relative flex h-full flex-col bg-[#f5f5f3] text-[#0a0a0a]">
      {/* Sticky header */}
      <header className="z-30 border-b border-[#0a0a0a14] bg-[#f5f5f3]/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[820px] items-center gap-3 px-4 py-3 sm:px-6">
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-[#0a0a0a14]"
            style={{ backgroundColor: channelColor }}
            aria-label="Switch channels"
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold tracking-[-0.015em] sm:text-lg">
              {channelName}
            </h1>
            <p className="truncate text-xs text-[#9a9a9a]">
              {handle ? `signed as ${handle}` : 'sender not set'}
            </p>
          </div>
          <div className="hidden items-center gap-1.5 text-xs text-[#9a9a9a] sm:flex">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#16a34a]" />
            <span>Live</span>
          </div>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#16a34a] sm:hidden" />
          <div className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#0a0a0a14] bg-white text-[#0a0a0a]">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
              <path d="M10 17a2 2 0 0 0 4 0" />
            </svg>
            {badgeCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-[#b91c1c] px-1 text-[10px] font-semibold leading-tight text-white">
                {badgeCount}
              </span>
            )}
            {bellRingOverlay}
          </div>
          <div className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#0a0a0a14] bg-white text-[#0a0a0a]">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.6 9.2a2.6 2.6 0 1 1 4.1 2.1c-.9.6-1.7 1.1-1.7 2.2" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          <div className="inline-flex h-9 items-center justify-center rounded-full border border-[#0a0a0a14] bg-white px-3.5 text-xs font-medium text-[#0a0a0a]">
            Menu
          </div>
        </div>
      </header>

      {/* Message list */}
      <div className="chat-scroll relative flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto w-full max-w-[820px] px-4 pt-5 pb-28 sm:px-6 sm:pb-32">
          {messages.length === 0 && (
            <div className="rounded-[22px] border border-dashed border-[#0a0a0a14] bg-white p-8 text-center">
              <p className="text-base font-semibold text-[#0a0a0a]">No messages yet.</p>
              <p className="mt-2 text-sm leading-6 text-[#6b6b6b]">Start with a note.</p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {messages.map((m) => {
              if (m.type === 'system') {
                return (
                  <div key={m.id} className="my-1 flex justify-center">
                    <p className="rounded-full bg-[#efefec] px-3 py-1 text-[11px] text-[#9a9a9a]">
                      {m.content} · {m.timestamp}
                    </p>
                  </div>
                );
              }
              const isMine = m.who === 'me';
              const senderLabel = m.sender || (isMine ? 'You' : null);
              return (
                <div key={m.id} className={`flex w-full flex-col ${isMine ? 'items-end' : 'items-start'}`}>
                  {senderLabel && (
                    <p className="mb-1 px-2 text-[11px] text-[#9a9a9a]">{senderLabel}</p>
                  )}
                  <div
                    className={`max-w-[82%] sm:max-w-[72%] rounded-[18px] px-4 py-2.5 leading-6 ${
                      isMine
                        ? 'rounded-br-[6px] bg-[#0a0a0a] text-white'
                        : 'rounded-bl-[6px] border border-[#0a0a0a14] bg-white text-[#0a0a0a]'
                    }`}
                  >
                    <p className="whitespace-pre-line break-words text-[15px]">{m.content}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Floating Compose button — PWA uses `fixed`, but inside our phone
          frame `fixed` resolves against the whole Remotion canvas (1080x1920),
          not the phone screen. Use absolute on the app-shell so it pins to
          the phone bottom. Sibling of the scroll container, not a child of it. */}
      {!hideComposer && (
        <div className="absolute bottom-4 left-4 right-4 z-30 rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-5 py-3.5 text-center text-sm font-medium text-white shadow-[0_12px_28px_-8px_rgba(10,10,10,0.4)]">
          {composerLabel}
        </div>
      )}

      {/* Join queue modal */}
      {showQueue && (
        <div className="absolute inset-0 z-40 bg-[rgba(10,10,10,0.45)] px-4 pt-6">
          <div className="mx-auto mt-6 flex max-h-[calc(100%-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[22px] border border-[#0a0a0a14] bg-[#f5f5f3] shadow-[0_24px_60px_-20px_rgba(10,10,10,0.3)]">
            <div className="flex items-center justify-between border-b border-[#0a0a0a14] bg-white px-5 py-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.32em] text-[#9a9a9a]">Notifications</p>
                <h2 className="mt-1 text-lg font-semibold tracking-[-0.015em]">Join queue</h2>
              </div>
              <span className="text-sm font-medium text-[#6b6b6b]">Close</span>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-5">
              {knocks.length === 0 && (
                <div className="rounded-[22px] border border-dashed border-[#0a0a0a14] bg-white p-8 text-center">
                  <p className="text-base font-semibold">No one is waiting.</p>
                  <p className="mt-2 text-sm text-[#6b6b6b]">
                    New join requests appear here. The bell badge lights up when someone knocks.
                  </p>
                </div>
              )}
              {knocks.length > 0 && (
                <div className="grid gap-3">
                  {knocks.map((knock) => (
                    <div key={knock.id} className="rounded-[18px] border border-[#0a0a0a14] bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-[#0a0a0a]">Join request</p>
                          <p className="mt-0.5 text-xs text-[#9a9a9a]">{knock.when}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-[#1a1a1a]">
                        {knock.note || 'No note included.'}
                      </p>
                      <div className="mt-4 flex gap-2">
                        <div className="flex-1 rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-4 py-2 text-center text-sm font-medium text-white">
                          Approve
                        </div>
                        <div className="flex-1 rounded-full border border-[#0a0a0a14] bg-white px-4 py-2 text-center text-sm font-medium text-[#0a0a0a]">
                          Reject
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
