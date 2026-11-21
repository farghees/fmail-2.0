import Link from "next/link";
export const metadata = { title: "Notis Privasi | Fmail" };
export default function PrivacyPage() {
 return <main lang="ms" className="mx-auto max-w-3xl px-6 py-12 text-neutral-800">
  <Link href="/" className="text-sm text-blue-700">Fmail</Link>
  <h1 className="mb-8 mt-6 text-3xl font-semibold tracking-tight">Notis Privasi Fmail</h1>
  <div className="space-y-6 text-base leading-7">
   <p>Apabila anda log masuk dengan Google, kami menerima ID akaun, alamat e-mel yang disahkan dan maklumat profil asas untuk pendaftaran, log masuk, paparan profil serta alamat pemulihan awal. Kami tidak meminta akses membaca atau menghantar Gmail dan tidak menyimpan password Google anda.</p>
   <p>Mesej, lampiran, tetapan akaun dan rekod keselamatan diproses serta disimpan untuk menyediakan perkhidmatan di Cloudflare. E-mel keluar diproses melalui penyedia penghantaran yang dikonfigurasi oleh pengendali, kepada penerima pilihan anda.</p>
   <p>Forwarding tidak aktif secara lalai. Jika dipilih, alamat Google anda didaftarkan sebagai destinasi Cloudflare Email Routing. Selepas anda mengesahkannya melalui e-mel Cloudflare, salinan e-mel masuk boleh dihantar ke alamat itu. Mesej asal kekal di Fmail. Anda boleh mematikan forwarding dalam tetapan; ini tidak memadam pendaftaran destinasi di Cloudflare.</p>
   <p>Alamat pemulihan boleh diubah dalam tetapan. Untuk permintaan pemadaman akaun/data atau pertanyaan privasi, hubungi pengendali perkhidmatan melalui saluran sokongan yang ditetapkan untuk pemasangan ini. Pengesahan identiti mungkin diperlukan. Notis ini boleh dikemas kini apabila amalan data perkhidmatan berubah.</p>
  </div>
 </main>;
}
