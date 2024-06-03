import {
  MiIOT,
  MiNA,
  MiServiceConfig,
  getMiIOT,
  getMiNA,
} from "mi-service-lite";
import { clamp, jsonEncode, sleep } from "../../utils/base";
import { Logger } from "../../utils/log";
import { StreamResponse } from "./stream";
import { kAreYouOK } from "../../utils/string";

export type TTSProvider = "xiaoai" | "doubao";

type Speaker = {
  name: string;
  gender: "男" | "女";
  speaker: string;
};

type ActionCommand = [number, number];
type PropertyCommand = [number, number, number];

export type BaseSpeakerConfig = MiServiceConfig & {
  debug?: boolean;
  /**
   * 语音合成服务商
   */
  tts?: TTSProvider;
  /**
   * 小爱音箱 TTS 指令
   *
   * 比如：小爱音箱 Pro（lx06） -> [5, 1]
   *
   * 具体指令可在此网站查询：https://home.miot-spec.com
   */
  ttsCommand?: ActionCommand;
  /**
   * 小爱音箱唤醒指令
   *
   * 比如：小爱音箱 Pro（lx06） -> [5, 3]
   *
   * 具体指令可在此网站查询：https://home.miot-spec.com
   */
  wakeUpCommand?: ActionCommand;
  /**
   * 查询小爱音响是否在播放中指令
   *
   * 比如：小爱音箱 Play（lx05） -> [3, 1, 1]
   *
   * 具体指令可在此网站查询：https://home.miot-spec.com
   */
  playingCommand?: PropertyCommand;
  /**
   * 播放状态检测间隔（单位毫秒，最低 500 毫秒，默认 1 秒）
   */
  checkInterval?: number;
  /**
   * TTS 开始/结束提示音
   */
  audioBeep?: string;
};

export class BaseSpeaker {
  logger = Logger.create({ tag: "Speaker" });
  MiNA?: MiNA;
  MiIOT?: MiIOT;
  debug = false;
  checkInterval: number;
  tts: TTSProvider;
  ttsCommand: ActionCommand;
  wakeUpCommand: ActionCommand;
  playingCommand?: PropertyCommand;
  config: MiServiceConfig;
  constructor(config: BaseSpeakerConfig) {
    this.config = config;
    const {
      debug = false,
      checkInterval = 1000,
      tts = "xiaoai",
      playingCommand,
      ttsCommand = [5, 1],
      wakeUpCommand = [5, 3],
      audioBeep = process.env.audioBeep,
    } = config;
    this.debug = debug;
    this.audioBeep = audioBeep;
    this.checkInterval = clamp(checkInterval, 500, Infinity);
    this.tts = tts;
    this.ttsCommand = ttsCommand;
    this.wakeUpCommand = wakeUpCommand;
    this.playingCommand = playingCommand;
  }

  async initMiServices() {
    this.MiNA = await getMiNA(this.config);
    this.MiIOT = await getMiIOT(this.config);
    this.logger.assert(!!this.MiNA && !!this.MiIOT, "init Mi Services failed");
  }

  wakeUp() {
    return this.MiIOT!.doAction(...this.wakeUpCommand);
  }

  async unWakeUp() {
    // 通过 TTS 不发音文本，使小爱退出唤醒状态
    await this.MiNA!.pause();
    await this.MiIOT!.doAction(...this.ttsCommand, kAreYouOK);
  }

  audioBeep?: string;
  responding = false;
  /**
   * 检测是否有新消息
   *
   * 有新消息产生时，旧的回复会终止
   */
  checkIfHasNewMsg() {
    return { hasNewMsg: () => false, noNewMsg: () => true };
  }
  async response(options: {
    tts?: TTSProvider;
    text?: string;
    stream?: StreamResponse;
    audio?: string;
    speaker?: string;
    keepAlive?: boolean;
    playSFX?: boolean;
    hasNewMsg?: () => boolean;
  }) {
    let {
      text,
      audio,
      stream,
      playSFX = true,
      keepAlive = false,
      tts = this.tts,
    } = options ?? {};
    options.hasNewMsg ??= this.checkIfHasNewMsg().hasNewMsg;

    const doubaoTTS = process.env.TTS_DOUBAO;
    if (!doubaoTTS) {
      tts = "xiaoai"; // 没有提供豆包语音接口时，只能使用小爱自带 TTS
    }

    const ttsNotXiaoai = (!!stream || !!text) && !audio && tts !== "xiaoai";
    playSFX = ttsNotXiaoai && playSFX;

    if (ttsNotXiaoai && !stream) {
      // 长文本 TTS 转化成 stream 分段模式
      stream = StreamResponse.createStreamResponse(text!);
    }

    let res;
    this.responding = true;
    // 开始响应
    if (stream) {
      let _response = "";
      while (true) {
        const { nextSentence, noMore } = stream.getNextResponse();
        if (nextSentence) {
          if (_response.length < 1) {
            // 播放开始提示音
            if (playSFX) {
              await this.MiNA!.play({ url: this.audioBeep });
            }
            // 在播放 TTS 语音之前，先取消小爱音箱的唤醒状态，防止将 TTS 语音识别成用户指令
            if (ttsNotXiaoai) {
              await this.unWakeUp();
            }
          }
          res = await this._response({
            ...options,
            text: nextSentence,
            playSFX: false,
            keepAlive: false,
          });
          if (res === "break") {
            // 终止回复
            stream.cancel();
            break;
          }
          _response += nextSentence;
        }
        if (noMore) {
          if (_response.length > 0) {
            // 播放结束提示音
            if (playSFX) {
              await this.MiNA!.play({ url: this.audioBeep });
            }
          }
          // 保持唤醒状态
          if (keepAlive) {
            await this.wakeUp();
          }
          // 播放完毕
          break;
        }
        await sleep(this.checkInterval);
      }
    } else {
      res = await this._response(options);
    }
    this.responding = false;
    return res;
  }

  private async _response(options: {
    tts?: TTSProvider;
    text?: string;
    stream?: StreamResponse;
    audio?: string;
    speaker?: string;
    keepAlive?: boolean;
    playSFX?: boolean;
    hasNewMsg?: () => boolean;
  }) {
    let {
      text,
      audio,
      stream,
      playSFX = true,
      keepAlive = false,
      tts = this.tts,
      speaker = this._defaultSpeaker,
    } = options ?? {};

    const hasNewMsg = () => {
      const flag = options.hasNewMsg?.();
      if (this.debug) {
        this.logger.debug("checkIfHasNewMsg:" + flag);
      }
      return flag;
    };

    const ttsText = text?.replace(/\n\s*\n/g, "\n")?.trim();
    const ttsNotXiaoai = !stream && !!text && !audio && tts !== "xiaoai";
    playSFX = ttsNotXiaoai && playSFX;

    // 播放回复
    const play = async (args?: { tts?: string; url?: string }) => {
      // 播放开始提示音
      if (playSFX && this.audioBeep) {
        await this.MiNA!.play({ url: this.audioBeep });
      }
      // 在播放 TTS 语音之前，先取消小爱音箱的唤醒状态，防止将 TTS 语音识别成用户指令
      if (ttsNotXiaoai) {
        await this.unWakeUp();
      }
      if (args?.tts) {
        await this.MiIOT!.doAction(...this.ttsCommand, args.tts);
      } else {
        await this.MiNA!.play(args);
      }
      this.logger.log("🔊 " + (ttsText ?? audio));
      // 等待 3 秒，确保本地设备状态已更新
      await sleep(3000);
      // 等待回答播放完毕
      while (true) {
        let playing: any = { status: "idle" };
        if (this.playingCommand) {
          const res = await this.MiIOT!.getProperty(
            this.playingCommand[0],
            this.playingCommand[1]
          );
          if (this.debug) {
            this.logger.debug(jsonEncode({ playState: res ?? "undefined" }));
          }
          if (res === this.playingCommand[2]) {
            playing = { status: "playing" };
          }
        } else {
          const res = await this.MiNA!.getStatus();
          if (this.debug) {
            this.logger.debug(jsonEncode({ playState: res ?? "undefined" }));
          }
          playing = { ...playing, ...res };
        }
        if (
          hasNewMsg() ||
          !this.responding || // 有新消息
          (playing.status === "playing" && playing.media_type) // 小爱自己开始播放音乐
        ) {
          // 响应被中断
          return "break";
        }
        if (playing.status !== "playing") {
          break;
        }
        await sleep(this.checkInterval);
      }
      // 播放结束提示音
      if (playSFX && this.audioBeep) {
        await this.MiNA!.play({ url: this.audioBeep });
      }
      // 保持唤醒状态
      if (keepAlive) {
        await this.wakeUp();
      }
    };

    // 开始响应
    let res;
    if (audio) {
      // 音频回复
      res = await play({ url: audio });
    } else if (ttsText) {
      // 文字回复
      switch (tts) {
        case "doubao":
          const _text = encodeURIComponent(ttsText);
          const doubaoTTS = process.env.TTS_DOUBAO;
          const url = `${doubaoTTS}?speaker=${speaker}&text=${_text}`;
          res = await play({ url });
          break;
        case "xiaoai":
        default:
          res = await play({ tts: ttsText });
          break;
      }
    }
    return res;
  }

  private _doubaoSpeakers?: Speaker[];
  private _defaultSpeaker = "zh_female_maomao_conversation_wvae_bigtts";
  async switchDefaultSpeaker(speaker: string) {
    const speakersAPI = process.env.SPEAKERS_DOUBAO;
    if (!this._doubaoSpeakers && speakersAPI) {
      const res = await (await fetch(speakersAPI)).json();
      if (Array.isArray(res)) {
        this._doubaoSpeakers = res;
      }
    }
    if (!this._doubaoSpeakers) {
      return false;
    }
    const target = this._doubaoSpeakers.find(
      (e) => e.name === speaker || e.speaker === speaker
    );
    if (target) {
      this._defaultSpeaker = target.speaker;
    }
    return this._defaultSpeaker === target?.speaker;
  }
}
