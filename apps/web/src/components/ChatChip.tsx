import { splitChatRefs } from "@renki/client-core";
import { useNavigate } from "react-router-dom";

/**
 * A reference to another Renki chat (`[@Title](renki://chat/<id>)`, see
 * client-core's chatRefs), drawn as a chip that opens that chat.
 */
export function ChatChip({ id, title }: { id: string; title: string }) {
  const navigate = useNavigate();
  return (
    <a
      href={`/session/${encodeURIComponent(id)}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // a new tab is fine: it's a real app URL
        e.preventDefault();
        navigate(`/session/${encodeURIComponent(id)}`);
      }}
      title={`Open “${title}”`}
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md bg-(--renki-accent)/12 px-1.5 py-px align-baseline text-[13px] font-medium text-(--renki-link) no-underline hover:bg-(--renki-accent)/20"
    >
      <span className="codicon codicon-comment-discussion text-[12px]" aria-hidden />
      <span className="truncate">{title}</span>
    </a>
  );
}

/** A message's plain text with its chat references drawn as chips. */
export function TextWithChatRefs({ text }: { text: string }) {
  const parts = splitChatRefs(text);
  if (parts.length === 1 && parts[0]!.type === "text") return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : <ChatChip key={i} id={p.id} title={p.title} />))}
    </>
  );
}
