# Открытый набор текстовых диалогов продаж (VadimHursevich/saas-sales-russian, Hugging Face): только телефонные
# разговоры, поровну «сделка была / не было», фиксированная выборка. Скачивается при запуске evals, в репозиторий не кладётся.
import json, sys, urllib.request, pyarrow.parquet as pq, io
URL = "https://huggingface.co/datasets/VadimHursevich/saas-sales-russian/resolve/main/data/train-00000-of-00001.parquet"
n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
t = pq.read_table(io.BytesIO(urllib.request.urlopen(URL, timeout=120).read())).to_pandas()
p = t[t.communication_channel == "phone_call"].sort_values("conversation_id")
out = []
for label in (1, 0):
    for _, r in p[p.outcome == label].head(n // 2).iterrows():
        out.append({"id": r.conversation_id, "outcome": int(r.outcome), "product": r.product_name, "turns": json.loads(r.conversation)})
json.dump(out, open(sys.argv[1], "w"), ensure_ascii=False)
print(len(out), "диалогов")
