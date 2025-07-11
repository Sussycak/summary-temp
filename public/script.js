const app = new Vue({
    el: "#app",
    data: {
        socket: null,
        mic: {
            mediaRecorder: null,
            stream: null,
        },
        settings: {
            mode: "transcribe",
            translation: false,
            transcription: false,
        },
        phrases: {
            final: [],
            pending: [],
        },
        summaryResult: null,
        isGeneratingSummary: false,
        lastWordTime: Date.now(),
        lockedSpeakers: {},
        currentSpeaker: null,
        currentSegmentWords: [],
        speakerColors: {
            "Speaker 1": "#F44336",
            "Speaker 2": "#2196F3",
            "Speaker 3": "#4CAF50",
            "Speaker 4": "#9C27B0",
            "Speaker 5": "#FF9800",
            "Speaker 6": "#FFC107",
            "Speaker 7": "#8BC34A",
            "Speaker 8": "#3F51B5",
            "Speaker 9": "#FF5722",
            "Speaker 10": "#00BCD4",
            "Speaker 11": "#00BCD4",
            "Speaker 12": "#00BCD4",
            "Speaker 13": "#00BCD4",
            "Speaker 14": "#00BCD4",
            "Speaker 15": "#00BCD4",
            "Speaker 16": "#00BCD4",
            "Speaker 17": "#00BCD4",
            "Speaker 18": "#00BCD4",
        },
    },
    async created() {
        console.log("Vue app is initializing...");
        this.setModeBasedOnUrlParam();
        await this.getUserMic();
    },
    methods: {
        setModeBasedOnUrlParam() {
            const url = new URL(location.href);
            const search = new URLSearchParams(url.search);
            if (!search.has("mode")) {
                search.set("mode", "badge");
                window.history.replaceState(null, "", "?" + search.toString());
            }
            this.settings.mode = search.get("mode");
            console.log("App mode set to:", this.settings.mode);
        },
        navigateTo(mode) {
            const url = new URL(location.href);
            const search = new URLSearchParams(url.search);
            search.set("mode", mode);
            window.history.replaceState(null, "", "?" + search.toString());
            this.settings.mode = mode;
        },
        async getUserMic() {
            try {
                const permissions = await navigator.permissions.query({ name: "microphone" });
                if (permissions.state === "denied") {
                    alert("Akses mikrofon ditolak secara permanen. Silakan ubah pengaturan browser Anda.");
                    this.mic.stream = null;
                    return;
                }
                this.mic.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                if (!MediaRecorder.isTypeSupported("audio/webm")) {
                    throw new Error("Browser tidak mendukung format audio/webm");
                }
                this.mic.mediaRecorder = new MediaRecorder(this.mic.stream, { mimeType: "audio/webm" });
                console.log("Mikrofon berhasil diakses.");
            } catch (err) {
                console.error("Error accessing microphone:", err);
                alert(`Gagal mengakses mikrofon: ${err.message}`);
            }
        },
        async beginTranscription(type = "single") {
            try {
                if (!this.mic.mediaRecorder) {
                    alert("Mikrofon belum diakses, silakan refresh dan izinkan akses mikrofon.");
                    return;
                }
                this.settings.transcription = type;
                const { key } = await fetch("/deepgram-token").then((r) => r.json());
                const wsUrl =
                    "wss://api.deepgram.com/v1/listen?" +
                    "model=nova-2&punctuate=true&diarize=true" +
                    "&diarize_speaker_count=18&smart_format=true&language=id";
                this.socket = new WebSocket(wsUrl, ["token", key]);
                this.socket.onopen = () => {
                    console.log("WebSocket connected.");
                    this.mic.mediaRecorder.addEventListener("dataavailable", (event) => {
                        if (event.data.size > 0 && this.socket.readyState === WebSocket.OPEN) {
                            this.socket.send(event.data);
                        }
                    });
                    this.mic.mediaRecorder.start(1000);
                };
                this.socket.onmessage = (message) => this.transcriptionResults(JSON.parse(message.data));
                this.socket.onerror = (error) => {
                    console.error("WebSocket error:", error);
                    alert("Terjadi kesalahan pada koneksi WebSocket.");
                };
                this.socket.onclose = () => {
                    console.log("WebSocket connection closed.");
                    this.settings.transcription = false;
                };
            } catch (error) {
                console.error("Error starting transcription:", error);
                alert("Gagal memulai transkripsi.");
            }
        },
        async transcriptionResults(data) {
            if (!data?.channel?.alternatives?.length) return;
            const { is_final, channel } = data;
            const words = channel.alternatives[0].words || [];
            if (!words.length) return;

            const rawId = words[0].speaker ?? 0;
            if (!(rawId in this.lockedSpeakers)) {
                const used = Object.values(this.lockedSpeakers);
                let n = 1;
                while (used.includes(`Speaker ${n}`)) n++;
                this.lockedSpeakers[rawId] = `Speaker ${n}`;
            }
            const speaker = this.lockedSpeakers[rawId];

            this.currentSegmentWords = words.map(w => w.punctuated_word || w.word);

            if (this.currentSpeaker && speaker !== this.currentSpeaker) {
                await this.flushSegment();
            } else if (is_final) {
                await this.flushSegment();
                this.lastWordTime = Date.now();
            }
            this.currentSpeaker = speaker;
        },
        async flushSegment() {
            if (!this.currentSegmentWords.length || !this.currentSpeaker) return;
            const rawText = this.currentSegmentWords.join(' ').trim();
            let formatted = rawText;
            try {
                const resp = await fetch('/punctuate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: rawText })
                });
                const json = await resp.json();
                if (json.formattedText) formatted = json.formattedText;
            } catch (e) {
                console.error('Punctuation error:', e);
            }
            this.phrases.final.push({ speaker: this.currentSpeaker, word: formatted.trim() });
            this.currentSegmentWords = [];
        },
        async fixPunctuation() { },
        stopTranscription() {
            if (this.mic.mediaRecorder && this.mic.mediaRecorder.state !== "inactive")
                this.mic.mediaRecorder.stop();
            if (this.socket && this.socket.readyState === WebSocket.OPEN)
                this.socket.close();
            this.settings.transcription = false;
        },
        clearTranscript() {
            this.phrases.final = [];
            this.phrases.pending = [];
            this.lockedSpeakers = {};
            this.currentSpeaker = null;
            this.currentSegmentWords = [];
            this.summaryResult = null;
        },
        async fetchSummaryAndDownload() {
            if (this.isGeneratingSummary) return;
            if (!this.singleTranscript) {
                alert("Tidak ada transkripsi untuk diringkas dan diunduh!");
                return;
            }
            this.isGeneratingSummary = true;

            try {
                const groupedTranscript = [];
                if (this.groupTranscript.length > 0) {
                    groupedTranscript.push({
                        speaker: this.groupTranscript[0].speaker,
                        word: this.groupTranscript[0].word
                    });
                    for (let i = 1; i < this.groupTranscript.length; i++) {
                        const currentSegment = this.groupTranscript[i];
                        const lastGroupedSegment = groupedTranscript[groupedTranscript.length - 1];
                        if (currentSegment.speaker === lastGroupedSegment.speaker) {
                            lastGroupedSegment.word += ' ' + currentSegment.word;
                        } else {
                            groupedTranscript.push({
                                speaker: currentSegment.speaker,
                                word: currentSegment.word
                            });
                        }
                    }
                }

                const summaryPromises = groupedTranscript.map(segment =>
                    fetch('/api/summarize-text', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: segment.word })
                    }).then(res => res.json())
                );

                const overallSummaryPromise = fetch('/api/summarize-text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: this.singleTranscript })
                }).then(res => res.json());

                const topicPromise = fetch('/api/get-topic', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: this.singleTranscript })
                }).then(res => res.json());

                const [individualSummaries, overallSummaryResult, topicResult] = await Promise.all([
                    Promise.all(summaryPromises),
                    overallSummaryPromise,
                    topicPromise
                ]);

                const processedData = groupedTranscript.map((segment, index) => ({
                    speaker: segment.speaker,
                    summary: individualSummaries[index]?.summary || "Tidak ada ringkasan."
                }));

                const overallSummary = overallSummaryResult.summary || "Tidak ada simpulan.";
                const topic = topicResult.topic || "Topik tidak teridentifikasi.";

                this.generateAndDownloadRTFInternal(processedData, overallSummary, topic);

            } catch (error) {
                console.error("Error fetching or processing summary:", error);
                alert(`Terjadi kesalahan saat membuat ringkasan: ${error.message}`);
            } finally {
                this.isGeneratingSummary = false;
            }
        },
        generateAndDownloadRTFInternal(processedData, overallSummary, topic) {
            let rtfContentParts = [];
            rtfContentParts.push(`{\\b NOTULEN RAPAT}\\par\\par`);

            const tableRowDefinition = `{\\trowd \\trgaph108 \\trvalignm\\clbrdrt\\brdrs\\brdrw10 \\clbrdrl\\brdrs\\brdrw10 \\clbrdrb\\brdrs\\brdrw10 \\clbrdrr\\brdrs\\brdrw10 \\cellx3000\\clbrdrt\\brdrs\\brdrw10 \\clbrdrl\\brdrs\\brdrw10 \\clbrdrb\\brdrs\\brdrw10 \\clbrdrr\\brdrs\\brdrw10 \\cellx7500\\clbrdrt\\brdrs\\brdrw10 \\clbrdrl\\brdrs\\brdrw10 \\clbrdrb\\brdrs\\brdrw10 \\clbrdrr\\brdrs\\brdrw10 \\cellx10000}`;

            const tableHeader = `${tableRowDefinition}\\pard\\intbl {\\b PERSOALAN}\\cell\\pard\\intbl {\\b TANGGAPAN PESERTA}\\cell\\pard\\intbl {\\b SIMPULAN/REKOMENDASI PIMPINAN}\\cell \\row}`;
            rtfContentParts.push(tableHeader);

            const tanggapanParts = [];
            processedData.forEach((data, index) => {
                const pointNumber = index + 1;
                const speakerText = `{\\b ${pointNumber}. ${this.escapeRtfText(String(data.speaker))}:}`;
                const wordText = this.escapeRtfText(String(data.summary).trim());
                tanggapanParts.push(`${speakerText} ${wordText}`);
            });
            const tanggapanKonten = tanggapanParts.join('\\par ');

            const simpulanKonten = this.escapeRtfText(String(overallSummary));
            const persoalanKonten = this.escapeRtfText(String(topic));

            const cell1_Persoalan = `\\pard\\intbl ${persoalanKonten}\\cell`;
            const cell2_Tanggapan = `\\pard\\intbl ${tanggapanKonten}\\cell`;
            const cell3_Simpulan = `\\pard\\intbl ${simpulanKonten}\\cell`;

            const tableRow = `${tableRowDefinition}${cell1_Persoalan}${cell2_Tanggapan}${cell3_Simpulan}\\row}`;
            rtfContentParts.push(tableRow);
            rtfContentParts.push('}');

            const rtfBody = rtfContentParts.join("\n");
            const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\viewkind4\\uc1\\pard\\f0\\fs24 ${rtfBody}}`;
            const blob = new Blob([rtf], { type: "application/rtf" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = "Notulen_Rapat.rtf";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        },
        escapeRtfText(text) {
            if (text === undefined || text === null) return "";
            let newText = String(text);
            newText = newText.replace(/\\/g, "\\\\");
            newText = newText.replace(/{/g, "\\{");
            newText = newText.replace(/}/g, "\\}");
            newText = newText.replace(/\r\n/g, "\\par ").replace(/\n/g, "\\par ");
            return newText;
        }
    },
    computed: {
        singleTranscript() {
            let transcript = "";
            let lastSp = null;
            let sentence = "";
            this.groupTranscript.forEach((w, i) => {
                if (lastSp && w.speaker !== lastSp) {
                    transcript += `\n\n${lastSp}: ${sentence.trim()}\n\n`;
                    sentence = "";
                }
                sentence += `${w.word} `;
                lastSp = w.speaker;
                if (i === this.groupTranscript.length - 1) {
                    transcript += `${lastSp}: ${sentence.trim()}`;
                }
            });
            return transcript.trim();
        },
        groupTranscript() {
            return [...this.phrases.final];
        }
    },
    watch: {
        singleTranscript: function () {
            this.$nextTick(() => {
                const transcriptContainer = this.$el.querySelector('.transcript-output');
                if (transcriptContainer) {
                    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
                }
            });
        }
    }
});
