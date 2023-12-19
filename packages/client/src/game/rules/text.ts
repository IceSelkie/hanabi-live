import type {
  ActionClue,
  ActionDiscard,
  ActionPlay,
  GameMetadata,
  MsgClue,
  NumPlayers,
  PlayerIndex,
  Variant,
} from "@hanabi/game";
import {
  ClueType,
  EndCondition,
  getCardName,
  getCardSlot,
  getCharacterNameForPlayer,
  getClueName,
  getVariant,
} from "@hanabi/game";
import type { Tuple } from "isaacscript-common-ts";
import { assertDefined } from "isaacscript-common-ts";

const HYPO_PREFIX = "[Hypo] ";
const WORDS = ["zero", "one", "two", "three", "four", "five", "six"] as const;

export function goesFirst(
  playerIndex: PlayerIndex | null,
  playerNames: Readonly<Tuple<string, NumPlayers>>,
): string {
  const playerName =
    playerIndex === null
      ? "[unknown]"
      : playerNames[playerIndex] ?? "[unknown]";

  return `${playerName} goes first`;
}

export function clue(
  action: ActionClue,
  targetHand: readonly number[],
  hypothetical: boolean,
  metadata: GameMetadata,
): string {
  const giver = metadata.playerNames[action.giver] ?? "unknown";
  const target = metadata.playerNames[action.target] ?? "unknown";
  const word = WORDS[action.list.length] ?? "unknown";
  const variant = getVariant(metadata.options.variantName);
  const hypoPrefix = hypothetical ? HYPO_PREFIX : "";

  // First, handle the case of clue text in some special variants.
  const characterName = getCharacterNameForPlayer(
    action.giver,
    metadata.characterAssignments,
  );
  if (variant.cowAndPig || variant.duck || characterName === "Quacker") {
    const actionName = getClueActionName(action.clue, variant, characterName);
    const targetSuffix = target.endsWith("s") ? "'" : "'s";

    // Create a list of slot numbers that correspond to the cards touched.
    const slots: number[] = [];
    for (const order of action.list) {
      const slot = getCardSlot(order, targetHand);
      assertDefined(slot, `Failed to get the slot for card: ${order}`);

      slots.push(slot);
    }
    slots.sort((a, b) => a - b);

    const slotWord = slots.length === 1 ? "slot" : "slots";
    const slotsText = slots.join("/");

    return `${hypoPrefix}${giver} ${actionName} at ${targetSuffix} ${slotWord} ${slotsText}`;
  }

  // Handle the default case of a normal clue.
  let clueName = getClueName(
    action.clue.type,
    action.clue.value,
    variant,
    characterName,
  );
  if (action.list.length !== 1) {
    clueName += "s";
  }

  return `${hypoPrefix}${giver} tells ${target} about ${word} ${clueName}`;
}

function getClueActionName(
  msgClue: MsgClue,
  variant: Variant,
  characterName: string,
): string {
  if (variant.cowAndPig) {
    switch (msgClue.type) {
      case ClueType.Color: {
        return "moos";
      }

      case ClueType.Rank: {
        return "oinks";
      }
    }
  }

  if (variant.duck || characterName === "Quacker") {
    return "quacks";
  }

  return "clues";
}

export function gameOver(
  endCondition: EndCondition,
  playerIndex: PlayerIndex,
  score: number,
  metadata: GameMetadata,
  votes: readonly PlayerIndex[] | null,
): string {
  const playerName = getPlayerName(playerIndex, metadata);

  switch (endCondition) {
    case EndCondition.InProgress:
    case EndCondition.Normal: {
      return `Players score ${score} points.`;
    }

    case EndCondition.Strikeout: {
      break;
    }

    case EndCondition.Timeout: {
      return `${playerName} ran out of time!`;
    }

    case EndCondition.TerminatedByPlayer: {
      return `${playerName} terminated the game!`;
    }

    case EndCondition.TerminatedByVote: {
      const playerNames = getPlayerNames(votes, metadata);
      return `${playerNames} voted to terminate the game!`;
    }

    case EndCondition.SpeedrunFail: {
      break;
    }

    case EndCondition.IdleTimeout: {
      return "Players were idle for too long.";
    }

    case EndCondition.CharacterSoftlock: {
      return `${playerName} was left with 0 clues!`;
    }

    case EndCondition.AllOrNothingFail: {
      break;
    }

    case EndCondition.AllOrNothingSoftlock: {
      return `${playerName} was left with 0 clues and 0 cards!`;
    }
  }

  return "Players lose!";
}

export function play(
  action: ActionPlay,
  slot: number | null,
  touched: boolean,
  playing: boolean,
  shadowing: boolean,
  hypothetical: boolean,
  metadata: GameMetadata,
): string {
  const variant = getVariant(metadata.options.variantName);
  const playerName = getPlayerName(action.playerIndex, metadata);

  const cardName =
    action.suitIndex === -1 ||
    action.rank === -1 ||
    (variant.throwItInAHole && (playing || shadowing))
      ? "a card"
      : getCardName(action.suitIndex, action.rank, variant);

  const location = slot === null ? "the deck" : `slot #${slot}`;

  let suffix = "";
  if (!touched) {
    suffix = " (blind)";
  }

  const hypoPrefix = hypothetical ? HYPO_PREFIX : "";
  return `${hypoPrefix}${playerName} plays ${cardName} from ${location}${suffix}`;
}

export function discard(
  action: ActionDiscard,
  slot: number | null,
  touched: boolean,
  playing: boolean,
  shadowing: boolean,
  hypothetical: boolean,
  metadata: GameMetadata,
): string {
  const variant = getVariant(metadata.options.variantName);
  const playerName = getPlayerName(action.playerIndex, metadata);

  let verb = "discards";
  if (action.failed) {
    verb = "fails to play";
    if (variant.throwItInAHole && (playing || shadowing)) {
      verb = "plays";
    }
  }

  const cardName =
    action.suitIndex === -1 || action.rank === -1
      ? "a card"
      : getCardName(action.suitIndex, action.rank, variant);

  const location = slot === null ? "the deck" : `slot #${slot}`;

  let suffix = "";
  if (action.failed && touched && !variant.throwItInAHole) {
    suffix = " (clued)";
  }
  if (action.failed && slot !== null && !touched) {
    suffix = " (blind)";
  }

  const hypoPrefix = hypothetical ? HYPO_PREFIX : "";
  return `${hypoPrefix}${playerName} ${verb} ${cardName} from ${location}${suffix}`;
}

export function getPlayerName(
  playerIndex: PlayerIndex,
  metadata: GameMetadata,
): string {
  return metadata.playerNames[playerIndex] ?? "[unknown]";
}

function getPlayerNames(
  playerIndices: readonly PlayerIndex[] | null,
  metadata: GameMetadata,
): string {
  if (playerIndices === null) {
    return "The players";
  }

  const playerNames = playerIndices.map((i) => getPlayerName(i, metadata));
  playerNames.sort();

  if (playerNames.length === 2) {
    return `${playerNames[0]} and ${playerNames[1]}`;
  }

  const playerNamesExceptLast = playerNames.slice(0, -1);
  return `${playerNamesExceptLast.join(", ")}, and ${playerNames.at(-1)}`;
}

export function millisecondsToClockString(milliseconds: number): string {
  // Non timed games measure time in negative values.
  const time = Math.abs(milliseconds);
  const seconds = Math.ceil(time / 1000);
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

function pad2(num: number) {
  if (num < 10) {
    return `0${num}`;
  }
  return `${num}`;
}
