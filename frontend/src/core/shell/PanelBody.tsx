import { useSyncExternalStore, type ReactNode } from "react";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import ArrowBack from "@mui/icons-material/ArrowBack";
import { panelTakeovers } from "./panelTakeovers";
import type { ShellViewEntry } from "./viewRegistry";

/**
 * The panel's body, or a contribution's in its place.
 *
 * The swap lives here rather than in each panel because every panel — host or
 * contributed, in every region — is already mounted through a shared path, so
 * a takeover costs no panel any code and cannot be forgotten by a new one.
 * Both mounts use this: the in-region one and the portable host, which renders
 * from a fixed position through a portal.
 *
 * The panel it replaces is **hidden, not unmounted**. `host.generate` is
 * `keepMounted` and `eager` precisely because its state is expensive to
 * rebuild, and handing the panel back should return the user to what they had,
 * not to a freshly mounted one.
 */
export function PanelBody({
  entry,
  children,
}: {
  readonly entry: ShellViewEntry;
  readonly children: ReactNode;
}) {
  useSyncExternalStore(
    (listener) => panelTakeovers.subscribe(listener),
    () => panelTakeovers.getRevision(),
    () => panelTakeovers.getRevision(),
  );
  const takeover = entry.takeoverable ? panelTakeovers.getActive(entry.id) : null;

  /**
   * One wrapper, always, whether or not a takeover is showing.
   *
   * Moving the panel between tree positions — bare child here, nested child
   * there — is a remount as far as React is concerned, which would throw away
   * exactly the state `keepMounted` exists to protect, on every open *and*
   * every close. So the wrapper is unconditional and only its `display`
   * changes; `contents` keeps it out of the layout entirely when idle, so a
   * panel that is not taken over lays out as if this element were not here.
   */
  const panel = (
    <Box sx={{ display: takeover ? "none" : "contents" }}>{children}</Box>
  );
  if (!takeover) return panel;

  const Body = takeover.component;
  return (
    <>
      {panel}
      <Box
        data-testid={`panel-takeover-${entry.id}`}
        sx={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          flexGrow: 1,
          height: "100%",
        }}
      >
        {/* Rendered by the frame, never by the contribution: a panel the user
            cannot give back is a panel an extension has taken, not borrowed. */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1,
            py: 0.5,
            borderBottom: "1px solid #2a2a2a",
            flexShrink: 0,
          }}
        >
          <Tooltip title={`Back to ${entry.title}`}>
            <IconButton
              size="small"
              aria-label={`Back to ${entry.title}`}
              onClick={() => panelTakeovers.close(takeover.id, true)}
              sx={{ p: 0.25 }}
            >
              <ArrowBack sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Typography
            sx={{ flex: 1, fontSize: "0.75rem", fontWeight: 600, minWidth: 0 }}
            noWrap
          >
            {takeover.title}
          </Typography>
        </Box>
        <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto" }}>
          <Body
            takeoverId={takeover.id}
            viewId={entry.id}
            close={() => panelTakeovers.close(takeover.id)}
          />
        </Box>
      </Box>
    </>
  );
}
