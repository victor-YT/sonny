export type TimingLabel =
  | 'vad_detection'
  | 'stt_transcription'
  | 'llm_first_token'
  | 'llm_full_response'
  | 'tts_synthesis'
  | 'audio_playback';

interface TimingStage {
  activeCount: number;
  startedAt?: number;
  endedAt?: number;
}

const TIMING_ORDER: TimingLabel[] = [
  'vad_detection',
  'stt_transcription',
  'llm_first_token',
  'llm_full_response',
  'tts_synthesis',
  'audio_playback',
];

const TIMING_LABELS: Record<TimingLabel, string> = {
  vad_detection: 'VAD detection',
  stt_transcription: 'STT transcription',
  llm_first_token: 'LLM first token',
  llm_full_response: 'LLM full response',
  tts_synthesis: 'TTS synthesis',
  audio_playback: 'Audio playback',
};

export class TimingTracker {
  private readonly interactionStartedAt: number;
  private readonly stages = new Map<TimingLabel, TimingStage>();
  private reported = false;

  public constructor(startedAt: number = Date.now()) {
    this.interactionStartedAt = startedAt;
  }

  public start(label: TimingLabel): void {
    const stage = this.getStage(label);

    if (stage.startedAt === undefined) {
      stage.startedAt = Date.now();
    }

    stage.activeCount += 1;
    stage.endedAt = undefined;
  }

  public end(label: TimingLabel): void {
    const stage = this.getStage(label);

    if (stage.startedAt === undefined) {
      stage.startedAt = Date.now();
    }

    if (stage.activeCount > 0) {
      stage.activeCount -= 1;
    }

    if (stage.activeCount === 0) {
      stage.endedAt = Date.now();
    }
  }

  public report(): string {
    if (this.reported) {
      return '';
    }

    this.reported = true;
    const lines = ['[timing] ─────────────────────────'];

    for (const label of TIMING_ORDER) {
      const stage = this.stages.get(label);
      const duration = this.getStageDuration(stage);

      if (duration === undefined) {
        continue;
      }

      const displayLabel = `${TIMING_LABELS[label]}:`.padEnd(19);

      lines.push(
        `[timing] ${displayLabel} ${String(duration).padStart(6)}ms`,
      );
    }

    lines.push('[timing] ─────────────────────────');

    const totalUserWait = this.getTotalUserWait();

    if (totalUserWait !== undefined) {
      lines.push(
        `[timing] Total user wait: ${String(totalUserWait).padStart(6)}ms (from speech end to audio start)`,
      );
    }

    return lines.join('\n');
  }

  private getStage(label: TimingLabel): TimingStage {
    let stage = this.stages.get(label);

    if (stage === undefined) {
      stage = {
        activeCount: 0,
      };
      this.stages.set(label, stage);
    }

    return stage;
  }

  private getStageDuration(stage: TimingStage | undefined): number | undefined {
    if (stage?.startedAt === undefined || stage.endedAt === undefined) {
      return undefined;
    }

    return Math.max(0, stage.endedAt - stage.startedAt);
  }

  private getTotalUserWait(): number | undefined {
    const speechEnd = this.stages.get('vad_detection')?.endedAt;
    const audioStart = this.stages.get('audio_playback')?.startedAt;

    if (speechEnd === undefined || audioStart === undefined) {
      return undefined;
    }

    return Math.max(0, audioStart - speechEnd);
  }
}
