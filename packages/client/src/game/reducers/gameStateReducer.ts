// Functions for building a state table for every turn.

import type { Variant } from "@hanabi/data";
import { getVariant } from "@hanabi/data";
import type { Draft } from "immer";
import { castDraft, original, produce } from "immer";
import { millisecondsToClockString } from "../../utils";
import * as cardRules from "../rules/card";
import * as clueTokensRules from "../rules/clueTokens";
import * as deckRules from "../rules/deck";
import * as handRules from "../rules/hand";
import * as playStacksRules from "../rules/playStacks";
import * as textRules from "../rules/text";
import * as variantRules from "../rules/variant";
import type { CardNote } from "../types/CardNote";
import type { CardState } from "../types/CardState";
import { ClueType } from "../types/ClueType";
import { EndCondition } from "../types/EndCondition";
import type { GameMetadata } from "../types/GameMetadata";
import { getPlayerName } from "../types/GameMetadata";
import type { GameState } from "../types/GameState";
import type { ActionDiscard, ActionPlay, GameAction } from "../types/actions";
import { cardsReducer } from "./cardsReducer";
import { ddaReducer } from "./ddaReducer";
import { knownTrashReducer } from "./knownTrashReducer";
import { statsReducer } from "./statsReducer";
import { turnReducer } from "./turnReducer";

export const gameStateReducer = produce(
  gameStateReducerFunction,
  {} as GameState,
);

function gameStateReducerFunction(
  state: Draft<GameState>,
  action: GameAction,
  playing: boolean,
  shadowing: boolean,
  finished: boolean,
  hypothetical: boolean,
  metadata: GameMetadata,
  ourNotes?: CardNote[],
) {
  const variant = getVariant(metadata.options.variantName);

  switch (action.type) {
    /**
     * A player just gave a clue:
     *
     * ```ts
     * {
     *   type: "clue",
     *   clue: { type: 0, value: 1 },
     *   giver: 1,
     *   list: [11],
     *   target: 2,
     *   turn: 0,
     * }
     * ```
     */
    case "clue": {
      state.clueTokens -= clueTokensRules.getAdjusted(1, variant);

      if (state.turn.segment === null) {
        throw new Error(
          `A "${action.type}" action happened before all of the initial cards were dealt.`,
        );
      }

      const negativeList = action.ignoreNegative
        ? []
        : state.hands[action.target]!.filter((i) => !action.list.includes(i));

      // Even though the objects for each clue type are the exact same, a switch statement is needed
      // to satisfy the TypeScript compiler.
      switch (action.clue.type) {
        case ClueType.Color: {
          state.clues.push({
            type: action.clue.type,
            value: action.clue.value,
            giver: action.giver,
            target: action.target,
            segment: state.turn.segment,
            list: action.list,
            negativeList,
          });
          break;
        }

        case ClueType.Rank: {
          state.clues.push({
            type: action.clue.type,
            value: action.clue.value,
            giver: action.giver,
            target: action.target,
            segment: state.turn.segment,
            list: action.list,
            negativeList,
          });
          break;
        }
      }

      const targetHand = state.hands[action.target]!;
      const text = textRules.clue(action, targetHand, hypothetical, metadata);
      state.log.push({
        turn: state.turn.turnNum + 1,
        text,
      });

      // Handle the "Card Cycling" game option.
      const giverHand = state.hands[action.giver]!;
      cardCycle(giverHand, castDraft(state.deck), metadata);

      break;
    }

    /**
     * A player just discarded a card.
     *
     * ```ts
     * {
     *   type: "discard",
     *   playerIndex: 0,
     *   order: 4,
     *   suitIndex: 2,
     *   rank: 1,
     *   failed: false,
     * }
     * ```
     */
    case "discard": {
      // Remove it from the hand.
      const hand = state.hands[action.playerIndex]!;
      const handIndex = hand.indexOf(action.order);
      let slot: number | null = null;
      if (handIndex !== -1) {
        // It is possible for players to misplay the deck.
        slot = hand.length - handIndex;
        hand.splice(handIndex, 1);
      }

      if (
        !throwItInAHolePlayedOrMisplayed(
          state,
          action,
          variant,
          playing,
          shadowing,
          finished,
        )
      ) {
        if (typeof action.suitIndex !== "number" || action.suitIndex < 0) {
          throw new Error(
            `The suit index for the discarded card was: ${action.suitIndex}`,
          );
        }

        // Add it to the discard stacks.
        state.discardStacks[action.suitIndex]!.push(action.order);

        // Discarding cards grants clue tokens under certain circumstances.
        state.clueTokens = clueTokensRules.gain(
          action,
          state.clueTokens,
          variant,
        );
      }

      const touched = cardRules.isClued(state.deck[action.order]!);
      const text = textRules.discard(
        action,
        slot,
        touched,
        playing,
        shadowing,
        hypothetical,
        metadata,
      );
      state.log.push({
        turn: state.turn.turnNum + 1,
        text,
      });

      break;
    }

    /**
     * A player just drew a card from the deck.
     *
     * ```ts
     * {
     *   type: "draw",
     *   playerIndex: 0,
     *   order: 0,
     *   rank: 1,
     *   suitIndex: 4,
     * }
     * ```
     */
    case "draw": {
      state.cardsRemainingInTheDeck--;
      const hand = state.hands[action.playerIndex];
      if (hand !== undefined) {
        hand.push(action.order);
      }

      if (
        deckRules.isInitialDealFinished(state.cardsRemainingInTheDeck, metadata)
      ) {
        const text = `${
          metadata.playerNames[state.turn.currentPlayerIndex!]
        } goes first`;
        state.log.push({
          turn: state.turn.turnNum + 1,
          text,
        });
      }

      break;
    }

    /**
     * The game has ended, either by normal means (e.g. max score), or someone ran out of time in a
     * timed game, someone terminated, etc.
     *
     * ```ts
     * {
     *   type: "gameOver",
     *   endCondition: 1,
     *   playerIndex: 0,
     * }
     * ```ts
     */
    case "gameOver": {
      if (action.endCondition !== EndCondition.Normal) {
        state.score = 0;
      }

      const text = textRules.gameOver(
        action.endCondition,
        action.playerIndex,
        state.score,
        metadata,
        action.votes,
      );
      state.log.push({
        turn: state.turn.turnNum + 1,
        text,
      });

      break;
    }

    /**
     * A player just played a card.
     *
     * ```ts
     * {
     *   type: "play",
     *   playerIndex: 0,
     *   order: 4,
     *   suitIndex: 2,
     *   rank: 1,
     * }
     * ```
     */
    case "play": {
      // Remove it from the hand.
      const hand = state.hands[action.playerIndex]!;
      const handIndex = hand.indexOf(action.order);
      let slot: number | null = null;
      if (handIndex !== -1) {
        slot = hand.length - handIndex;
        hand.splice(handIndex, 1);
      }

      // Add it to the play stacks.
      if (
        !throwItInAHolePlayedOrMisplayed(
          state,
          action,
          variant,
          playing,
          shadowing,
          finished,
        )
      ) {
        if (typeof action.suitIndex !== "number" || action.suitIndex < 0) {
          throw new Error(
            `The suit index for the played card was: ${action.suitIndex}`,
          );
        }

        const playStack = state.playStacks[action.suitIndex]!;
        playStack.push(action.order);

        // Playing cards grants clue tokens under certain circumstances.
        state.clueTokens = clueTokensRules.gain(
          action,
          state.clueTokens,
          variant,
          playStack.length === 5,
        );
      }

      // Gain a point.
      state.score++;

      const touched = cardRules.isClued(state.deck[action.order]!);
      const text = textRules.play(
        action,
        slot,
        touched,
        playing,
        shadowing,
        hypothetical,
        metadata,
      );
      state.log.push({
        turn: state.turn.turnNum + 1,
        text,
      });

      break;
    }

    case "playerTimes": {
      for (let i = 0; i < action.playerTimes.length; i++) {
        // Player times are negative in untimed games.
        const modifier = metadata.options.timed ? 1 : -1;
        const milliseconds = action.playerTimes[i]! * modifier;
        const durationString = millisecondsToClockString(milliseconds);
        const playerName = getPlayerName(i, metadata);

        const text = metadata.options.timed
          ? `${playerName} had ${durationString} left`
          : `${playerName} took: ${durationString}`;
        state.log.push({
          turn: state.turn.turnNum + 1,
          text,
        });
      }

      const clockString = millisecondsToClockString(action.duration);
      const text = `The total game duration was: ${clockString}`;
      state.log.push({
        turn: state.turn.turnNum + 1,
        text,
      });
      break;
    }

    /**
     * A player failed to play a card.
     *
     * ```ts
     * {
     *   type: "strike",
     *   num: 1,
     *   turn: 32,
     *   order: 24,
     * }
     * ```
     */
    // TODO: This message is unnecessary and will be removed in a future version of the code
    case "strike": {
      state.strikes.push({
        order: action.order,
        segment: state.turn.segment!,
      });
      break;
    }

    // Some actions do not affect the main state or are handled by another reducer.
    case "setEffMod":
    case "editNote":
    case "noteList":
    case "noteListPlayer":
    case "receiveNote":
    case "turn":
    case "cardIdentity": {
      break;
    }
  }

  if (action.type === "noteList" || action.type === "receiveNote") {
    // This has no effect, so don't bother computing anything.
    return;
  }

  // Use a sub-reducer to calculate changes on cards.
  state.deck = castDraft(
    cardsReducer(original(state.deck)!, action, state, metadata),
  );

  // Resolve the stack direction.
  if (
    action.type === "play" &&
    (variantRules.hasReversedSuits(variant) || variant.sudoku) &&
    action.suitIndex !== -1
  ) {
    // We have to wait until the deck is updated with the information of the card that we played
    // before the `direction` function will work.
    const playStack = state.playStacks[action.suitIndex]!;
    const direction = playStacksRules.direction(
      action.suitIndex,
      playStack,
      state.deck,
      variant,
    );
    state.playStackDirections[action.suitIndex] = direction;
  }

  // In Sudoku variants, resolve the stack starting value.
  if (action.type === "play" && variant.sudoku) {
    const playStack = state.playStacks[action.suitIndex]!;
    state.playStackStarts[action.suitIndex] = playStacksRules.stackStartRank(
      playStack,
      state.deck,
      variant,
    );
  }

  // Discarding or playing cards can make other card cards in that suit not playable anymore and can
  // make other cards critical.
  if (
    (action.type === "play" || action.type === "discard") &&
    action.suitIndex !== -1 &&
    action.rank !== -1
  ) {
    for (const rank of variant.ranks) {
      state.cardStatus[action.suitIndex]![rank] = cardRules.status(
        action.suitIndex,
        rank,
        state.deck,
        state.playStacks,
        state.playStackDirections,
        state.playStackStarts,
        variant,
      );
    }
  }

  // Use a sub-reducer to calculate the turn.
  state.turn = turnReducer(original(state.turn), action, state, metadata);

  // Use a sub-reducer to calculate some game statistics.
  state.stats = statsReducer(
    original(state.stats),
    action,
    original(state)!,
    state,
    playing,
    shadowing,
    metadata,
    ourNotes ?? null,
  );

  // After stats calculated, compute DDA property on all card states.
  state.deck = castDraft(
    ddaReducer(
      state.deck,
      state.stats.doubleDiscard,
      state.turn.currentPlayerIndex,
    ),
  );

  // Finally, mark cards as known-trash.
  state.deck = castDraft(
    knownTrashReducer(
      state.deck,
      state.playStacks,
      state.playStackDirections,
      state.playStackStarts,
      variant,
    ),
  );
}

function cardCycle(
  hand: number[],
  deck: readonly CardState[],
  metadata: GameMetadata,
) {
  if (!metadata.options.cardCycle) {
    return;
  }

  // We don't need to reorder anything if the chop is slot 1 (the left-most card).
  const chopIndex = handRules.chopIndex(hand, deck);
  if (chopIndex === hand.length - 1) {
    return;
  }

  // Remove the chop card from their hand.
  const removedCardOrder = hand.splice(chopIndex, 1)[0]!;

  // Add it to the end (the left-most position).
  hand.push(removedCardOrder);
}

function throwItInAHolePlayedOrMisplayed(
  state: Draft<GameState>,
  action: ActionPlay | ActionDiscard,
  variant: Variant,
  playing: boolean,
  shadowing: boolean,
  finished: boolean,
) {
  if (!variant.throwItInAHole || (!playing && !shadowing) || finished) {
    return false;
  }

  if ((action.type === "discard" && action.failed) || action.type === "play") {
    // In "Throw It in a Hole" variants, plays and unknown misplayed cards go the hole instead of
    // the play stack / discard pile.
    state.hole.push(action.order);

    // Keep track of attempted plays.
    state.numAttemptedCardsPlayed++;

    return true;
  }

  return false;
}
