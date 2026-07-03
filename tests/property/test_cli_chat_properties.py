"""PU3-5 — chat interrupt state machine (RuleBasedStateMachine vs trivial model).

Invariants: (a) at most one stop per turn, (b) exit only from idle,
(c) the machine never leaves its 4-state vocabulary.
"""

from __future__ import annotations

from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, rule

from caduceus.cli.chat import _TRANSITIONS, ChatState, transition

STATES: tuple[ChatState, ...] = ("idle", "streaming", "stopping", "awaiting_approval")
EVENTS = ("interrupt", "eof", "user_message", "approval_request", "approval_answered",
          "stream_end")


class ChatMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.state: ChatState = "idle"
        self.in_turn = False
        self.stops_this_turn = 0
        self.exited = False

    @rule(event=st.sampled_from(EVENTS))
    def fire(self, event: str) -> None:
        if self.exited:
            return
        before = self.state
        self.state, action = transition(self.state, event)  # type: ignore[arg-type]

        if action == "exit":
            assert before == "idle"  # (b) exit only from idle
            self.exited = True
        elif action == "start_turn":
            self.in_turn = True
            self.stops_this_turn = 0
        elif action == "send_stop":
            self.stops_this_turn += 1
            assert self.in_turn
            assert self.stops_this_turn <= 1  # (a) at most one stop per turn
        if event == "stream_end" and before != "idle":
            self.in_turn = False

    @invariant()
    def state_in_vocabulary(self) -> None:
        assert self.state in STATES  # (c)

    @invariant()
    def stop_only_reachable_via_streaming(self) -> None:
        # structural check on the table itself: send_stop appears exactly once,
        # and only out of "streaming"
        senders = [k for k, v in _TRANSITIONS.items() if v[1] == "send_stop"]
        assert senders == [("streaming", "interrupt")]


TestChatMachine = ChatMachine.TestCase


def test_transition_total_over_full_vocabulary() -> None:
    for state in STATES:
        for event in EVENTS:
            next_state, action = transition(state, event)  # type: ignore[arg-type]
            assert next_state in STATES
            assert isinstance(action, str)
