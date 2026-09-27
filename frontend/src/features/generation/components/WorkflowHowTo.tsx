import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Box,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  Tooltip,
  Typography,
} from "@mui/material";
import { Close, InfoOutlined } from "@mui/icons-material";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getWorkflowHowTo,
  workflowHowToAssetUrl,
  workflowSharedAssetUrl,
  type WorkflowHowTo as WorkflowHowToDocument,
  type WorkflowHowToFragment,
} from "../services/comfyuiApi";
import { resolveHowToRef, type HowToAssetUrls } from "../utils/howToRefs";
import {
  collectHowToHeadingIds,
  rehypeHowToHeadingIds,
} from "../utils/howToHeadings";

interface WorkflowHowToButtonProps {
  workflowId: string;
  workflowLabel: string;
}

/** Info icon that opens the workflow's how-to; render only when one exists. */
export function WorkflowHowToButton({
  workflowId,
  workflowLabel,
}: WorkflowHowToButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="How to use this workflow">
        <IconButton
          aria-label="How to use this workflow"
          color="primary"
          onClick={() => setOpen(true)}
          sx={{ ml: "auto", flexShrink: 0 }}
        >
          <InfoOutlined />
        </IconButton>
      </Tooltip>
      {open ? (
        <WorkflowHowToDialog
          workflowId={workflowId}
          workflowLabel={workflowLabel}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

interface WorkflowHowToDialogProps {
  workflowId: string;
  workflowLabel: string;
  onClose: () => void;
}

type HowToLoadState =
  | { status: "loading" }
  | { status: "ready"; document: WorkflowHowToDocument }
  | { status: "error"; message: string };

export function WorkflowHowToDialog({
  workflowId,
  workflowLabel,
  onClose,
}: WorkflowHowToDialogProps) {
  const [state, setState] = useState<HowToLoadState>({ status: "loading" });
  const contentRef = useRef<HTMLDivElement>(null);
  const headingIds = useMemo(
    () =>
      state.status === "ready"
        ? collectHowToHeadingIds(
            state.document.fragments.map((fragment) =>
              fragment.kind === "markdown" ? fragment.markdown : null,
            ),
          )
        : [],
    [state],
  );
  // Scroll within the dialog rather than following the link, which would
  // rewrite the app's own URL hash.
  const navigateToHeading = useCallback((targetId: string) => {
    const target = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>("[id]") ?? [],
    ).find((element) => element.id === targetId);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    getWorkflowHowTo(workflowId, controller.signal)
      .then((document) => setState({ status: "ready", document }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message:
            error instanceof Error ? error.message : "Failed to load the how-to",
        });
      });
    return () => controller.abort();
  }, [workflowId]);

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth scroll="paper">
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, pr: 1 }}>
        <Typography variant="h6" component="span" noWrap sx={{ flex: 1, minWidth: 0 }}>
          How to use {workflowLabel}
        </Typography>
        <IconButton aria-label="Close how-to" onClick={onClose}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers ref={contentRef}>
        {state.status === "loading" ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : state.status === "error" ? (
          <Alert severity="error">{state.message}</Alert>
        ) : (
          <Box sx={MARKDOWN_SX}>
            {state.document.fragments.map((fragment, index) => (
              <HowToFragment
                key={index}
                workflowId={workflowId}
                fragment={fragment}
                headingIds={headingIds[index] ?? NO_HEADING_IDS}
                onNavigateToHeading={navigateToHeading}
              />
            ))}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

const NO_HEADING_IDS: readonly string[] = [];

interface HowToFragmentProps {
  workflowId: string;
  fragment: WorkflowHowToFragment;
  headingIds: readonly string[];
  onNavigateToHeading: (targetId: string) => void;
}

function HowToFragment({
  workflowId,
  fragment,
  headingIds,
  onNavigateToHeading,
}: HowToFragmentProps) {
  if (fragment.kind === "missing") {
    return (
      <Alert severity="warning" sx={{ my: 1 }}>
        Missing how-to section: <code>{fragment.src}</code>
      </Alert>
    );
  }
  return (
    <MemoizedMarkdownFragment
      workflowId={workflowId}
      markdown={fragment.markdown}
      base={fragment.base}
      headingIds={headingIds}
      onNavigateToHeading={onNavigateToHeading}
    />
  );
}

const REMARK_PLUGINS = [remarkGfm];

// Refs are resolved (and unsafe schemes refused) by the components below,
// which need the raw value to tell bundle refs from shared ones.
function keepUrl(url: string): string {
  return url;
}

interface MarkdownFragmentProps {
  workflowId: string;
  markdown: string;
  base: string | null;
  headingIds: readonly string[];
  onNavigateToHeading: (targetId: string) => void;
}

function MarkdownFragment({
  workflowId,
  markdown,
  base,
  headingIds,
  onNavigateToHeading,
}: MarkdownFragmentProps) {
  // react-markdown treats each `components` entry as a component type, so a
  // fresh object on every render remounts the whole fragment. Any re-render
  // between mousedown and mouseup (the editor updates focus on pointerdown)
  // then swaps the pressed link for a new element and the click is lost.
  const components = useMemo(
    () =>
      createMarkdownComponents(
        base,
        {
          bundleAsset: (path) => workflowHowToAssetUrl(workflowId, path),
          sharedAsset: workflowSharedAssetUrl,
        },
        onNavigateToHeading,
      ),
    [base, workflowId, onNavigateToHeading],
  );
  const rehypePlugins = useMemo(
    () => [rehypeHowToHeadingIds(headingIds)],
    [headingIds],
  );
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      urlTransform={keepUrl}
      components={components}
    >
      {markdown}
    </Markdown>
  );
}

const MemoizedMarkdownFragment = memo(MarkdownFragment);

function MissingRef({ refText }: { refText: string }) {
  return (
    <Box
      component="span"
      sx={{ color: "warning.main", fontStyle: "italic" }}
      title="This reference could not be resolved"
    >
      [missing: {refText || "empty reference"}]
    </Box>
  );
}

function createMarkdownComponents(
  base: string | null,
  urls: HowToAssetUrls,
  onNavigateToHeading: (targetId: string) => void,
): Components {
  return {
    img: ({ src, alt }) => {
      const target = resolveHowToRef(
        typeof src === "string" ? src : undefined,
        base,
        urls,
      );
      if (target.kind === "asset") {
        return target.isVideo ? (
          <video
            src={target.url}
            aria-label={alt}
            controls
            loop
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <img src={target.url} alt={alt ?? ""} loading="lazy" />
        );
      }
      if (target.kind === "external") {
        // Remote media is linked, never embedded.
        return <ExternalLink href={target.url}>{alt || target.url}</ExternalLink>;
      }
      return <MissingRef refText={typeof src === "string" ? src : ""} />;
    },
    a: ({ href, children }) => {
      const target = resolveHowToRef(href, base, urls);
      if (target.kind === "external" || target.kind === "asset") {
        return <ExternalLink href={target.url}>{children}</ExternalLink>;
      }
      if (target.kind === "anchor") {
        return (
          <Link
            href={target.url}
            onClick={(event) => {
              event.preventDefault();
              onNavigateToHeading(target.targetId);
            }}
          >
            {children}
          </Link>
        );
      }
      return <span>{children}</span>;
    },
  };
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  );
}

const MARKDOWN_SX = {
  typography: "body2",
  "& h1": { typography: "h5", mt: 0, mb: 1.5 },
  "& h2": { typography: "h6", mt: 3, mb: 1 },
  "& h3": { typography: "subtitle1", fontWeight: 600, mt: 2, mb: 0.75 },
  "& p, & ul, & ol, & table, & pre": { mt: 0, mb: 1.5 },
  "& li + li": { mt: 0.5 },
  "& img, & video": {
    display: "block",
    maxWidth: "100%",
    borderRadius: 1,
    my: 1,
  },
  "& code": {
    fontFamily: "monospace",
    fontSize: "0.85em",
    bgcolor: "action.hover",
    px: 0.5,
    borderRadius: 0.5,
  },
  "& pre": { bgcolor: "action.hover", p: 1.5, borderRadius: 1, overflowX: "auto" },
  "& pre code": { bgcolor: "transparent", p: 0 },
  "& table": { borderCollapse: "collapse", width: "100%" },
  "& th, & td": {
    border: 1,
    borderColor: "divider",
    px: 1,
    py: 0.5,
    textAlign: "left",
    verticalAlign: "top",
  },
  "& blockquote": {
    borderLeft: 3,
    borderColor: "primary.main",
    m: 0,
    mb: 1.5,
    pl: 1.5,
    color: "text.secondary",
  },
} as const;
