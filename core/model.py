"""Canonical document model: Document -> Sentence -> Word, with stable char offsets."""
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class Word:
    text: str
    start: int  # char offset in the sentence's text
    end: int


@dataclass
class Sentence:
    id: int
    text: str
    words: list[Word] = field(default_factory=list)


@dataclass
class Document:
    title: str
    sentences: list[Sentence] = field(default_factory=list)

    @property
    def full_text(self) -> str:
        return " ".join(s.text for s in self.sentences)
