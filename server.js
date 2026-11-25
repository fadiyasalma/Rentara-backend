require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Inisialisasi Koneksi ke Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================================
// 1. CEK STATUS SERVER
// ============================================================================
app.get('/', (req, res) => {
  res.json({
    app: 'RENTARA Backend API',
    status: 'Online',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// 2. CARI MITRA TOKO TERDEKAT BERDASARKAN KOORDINAT PENYEWA
// Contoh: GET /api/vendors/nearby?lat=-7.4243&lng=109.2391
// ============================================================================
app.get('/api/vendors/nearby', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Parameter lat dan lng wajib diisi.' });
    }

    const { data, error } = await supabase.rpc('get_nearby_vendors', {
      p_user_lat: parseFloat(lat),
      p_user_lng: parseFloat(lng)
    });

    if (error) throw error;
    res.json({ total_vendors: data.length, vendors: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 3. CEK KETERSEDIAAN STOK BARANG (ANTI-DOUBLE BOOKING)
// Contoh: GET /api/items/dddddddd-dddd-dddd-dddd-dddddddddddd/availability?start_date=2026-12-05&end_date=2026-12-07
// ============================================================================
app.get('/api/items/:itemId/availability', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { start_date, end_date } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'Parameter start_date dan end_date wajib diisi.' });
    }

    const { data, error } = await supabase.rpc('check_item_availability', {
      p_item_id: itemId,
      p_req_start_date: start_date,
      p_req_end_date: end_date
    });

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Barang tidak ditemukan.' });
    }

    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 4. BUAT PESANAN SEWA BARU (ONLINE / TUNAI COD + AUTO TUGAS KURIR)
// ============================================================================
app.post('/api/rentals', async (req, res) => {
  try {
    const {
      customer_id,
      vendor_id,
      address_id,
      item_id,
      quantity = 1,
      start_date,
      end_date,
      payment_method_type, // 'online_gateway' atau 'cash_cod'
      courier_id // ID kurir internal yang ditugaskan
    } = req.body;

    // A. Validasi Profil & Syarat COD Penyewa
    const { data: customer, error: custErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', customer_id)
      .single();
    if (custErr || !customer) return res.status(404).json({ error: 'Penyewa tidak ditemukan.' });

    if (customer.unpaid_cancellation_fee > 0) {
      return res.status(403).json({
        error: `Akun memiliki tunggakan denda pembatalan sebesar Rp ${customer.unpaid_cancellation_fee}.`
      });
    }

    if (payment_method_type === 'cash_cod') {
      if (customer.kyc_status !== 'verified' || !customer.is_cod_eligible) {
        return res.status(403).json({
          error: 'Metode Tunai (COD) hanya tersedia untuk akun terverifikasi KTP dan bebas pelanggaran.'
        });
      }
    }

    // B. Validasi Stok pada Tanggal Sewa
    const { data: availData, error: availErr } = await supabase.rpc('check_item_availability', {
      p_item_id: item_id,
      p_req_start_date: start_date,
      p_req_end_date: end_date
    });
    if (availErr) throw availErr;
    if (!availData[0] || availData[0].available_stock < quantity) {
      return res.status(400).json({ error: 'Stok barang tidak mencukupi pada tanggal yang dipilih.' });
    }

    // C. Ambil Detail Barang, Mitra Toko, dan Alamat Penyewa
    const { data: item } = await supabase.from('items').select('*').eq('id', item_id).single();
    const { data: vendor } = await supabase.from('vendors').select('*').eq('id', vendor_id).single();
    const { data: address } = await supabase.from('user_addresses').select('*').eq('id', address_id).single();

    // Hitung Durasi Hari & Buffer Date (+1 hari perawatan)
    const startObj = new Date(start_date);
    const endObj = new Date(end_date);
    const diffDays = Math.max(1, Math.ceil((endObj - startObj) / (1000 * 60 * 60 * 24)) + 1);
    const bufferObj = new Date(endObj);
    bufferObj.setDate(bufferObj.getDate() + 1);
    const buffer_end_date = bufferObj.toISOString().split('T')[0];

    // Hitung Jarak Sederhana & Ongkir Kurir Internal (Rp 5.000 dasar + Rp 2.500/km)
    const distance_km = 2.5; // Di produksi dapat diambil dari hasil get_nearby_vendors / OSRM
    const delivery_fee = 5000 + Math.round(distance_km * 2500);

    // Hitung Biaya Sewa, Komisi Platform & Deposit
    const total_rent_price = item.daily_rate * quantity * diffDays;
    const platform_fee_amount = (total_rent_price * vendor.commission_rate) / 100;
    const vendor_net_income = total_rent_price - platform_fee_amount;
    const deposit_paid = item.deposit_amount * quantity;
    const grandTotal = total_rent_price + delivery_fee + deposit_paid;

    // Batas maksimal transaksi Tunai (COD) Rp 1.500.000
    if (payment_method_type === 'cash_cod' && grandTotal > 1500000) {
      return res.status(400).json({
        error: 'Total transaksi melebihi batas maksimal Tunai (COD) Rp 1.500.000. Silakan gunakan pembayaran online.'
      });
    }

    // D. Simpan Transaksi ke Tabel `rentals`
    const invoice_number = `INV-${Date.now()}`;
    const initialStatus = payment_method_type === 'cash_cod' ? 'confirmed' : 'pending_payment';

    const { data: rental, error: rentalErr } = await supabase
      .from('rentals')
      .insert([{
        invoice_number,
        customer_id,
        vendor_id,
        address_id,
        start_date,
        end_date,
        buffer_end_date,
        distance_km,
        total_rent_price,
        platform_fee_amount,
        vendor_net_income,
        delivery_fee,
        deposit_paid,
        payment_method_type,
        status: initialStatus
      }])
      .select()
      .single();

    if (rentalErr) throw rentalErr;

    // E. Simpan Rincian Barang ke `rental_items`
    await supabase.from('rental_items').insert([{
      rental_id: rental.id,
      item_id,
      quantity,
      price_per_day: item.daily_rate,
      deposit_per_unit: item.deposit_amount
    }]);

    // F. Jika COD (langsung confirmed), Buat Tugas Pengantaran untuk Kurir Internal
    let courierTask = null;
    if (payment_method_type === 'cash_cod' && courier_id) {
      const { data: task } = await supabase
        .from('courier_tasks')
        .insert([{
          rental_id: rental.id,
          courier_id,
          task_type: 'initial_delivery',
          origin_lat: vendor.latitude,
          origin_lng: vendor.longitude,
          dest_lat: address.latitude,
          dest_lng: address.longitude,
          scheduled_time: new Date().toISOString(),
          status: 'assigned'
        }])
        .select()
        .single();
      courierTask = task;
    }

    res.status(201).json({
      message: 'Pesanan sewa berhasil dibuat!',
      rental,
      grand_total_to_pay: grandTotal,
      courier_task: courierTask
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 5. UPDATE GPS KURIR REAL-TIME (DIPANGGIL HP KURIR TIAP 3-5 DETIK)
// ============================================================================
app.patch('/api/courier/tasks/:taskId/gps', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { lat, lng, status } = req.body;

    const updatePayload = {
      current_lat: lat,
      current_lng: lng,
      last_gps_updated_at: new Date().toISOString()
    };
    if (status) updatePayload.status = status;

    const { data, error } = await supabase
      .from('courier_tasks')
      .update(updatePayload)
      .eq('id', taskId)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: 'Lokasi GPS kurir diperbarui', task: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 6. SELESAI INSPEKSI & TERIMA TUNAI COD (OPEN-BOX HANDOVER)
// ============================================================================
app.post('/api/courier/tasks/:taskId/complete-handover', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { photo_proof_url, customer_signature_url, cash_collected_amount } = req.body;

    const { data: task } = await supabase
      .from('courier_tasks')
      .select('*, rentals(*)')
      .eq('id', taskId)
      .single();

    if (!task) return res.status(404).json({ error: 'Tugas kurir tidak ditemukan.' });

    // 1. Simpan Berita Acara Serah Terima (BAST) Digital
    await supabase.from('condition_logs').insert([{
      courier_task_id: taskId,
      check_stage: 'customer_handover',
      photo_proof_url,
      customer_agreed_condition: true,
      customer_signature_url,
      notes: 'Penyewa telah memeriksa fisik barang dan menyetujui kondisi awal.'
    }]);

    // 2. Selesaikan Tugas Kurir
    await supabase
      .from('courier_tasks')
      .update({
        status: 'completed',
        inspection_ended_at: new Date().toISOString(),
        completed_time: new Date().toISOString()
      })
      .eq('id', taskId);

    // 3. Ubah Status Sewa Menjadi 'active' & Catat Uang Tunai COD
    await supabase
      .from('rentals')
      .update({
        status: 'active',
        cod_collected_amount: cash_collected_amount || 0,
        cod_collected_at: cash_collected_amount ? new Date().toISOString() : null
      })
      .eq('id', task.rental_id);

    // 4. Tambah Saldo Kas Tunai yang Dipegang Kurir
    if (cash_collected_amount > 0) {
      const { data: courier } = await supabase
        .from('users')
        .select('courier_cash_on_hand')
        .eq('id', task.courier_id)
        .single();

      const newCashBalance = Number(courier.courier_cash_on_hand) + Number(cash_collected_amount);
      await supabase
        .from('users')
        .update({ courier_cash_on_hand: newCashBalance })
        .eq('id', task.courier_id);
    }

    res.json({ message: 'Serah terima selesai, pembayaran tunai tercatat, dan masa sewa resmi aktif!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 7. PENOLAKAN DI LOKASI SAAT INSPEKSI COD (ON-SITE REJECTION)
// ============================================================================
app.post('/api/courier/tasks/:taskId/reject-on-site', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { rejection_category, fault_party, evidence_photo_url, courier_notes } = req.body;

    const { data: task } = await supabase
      .from('courier_tasks')
      .select('*, rentals(*)')
      .eq('id', taskId)
      .single();

    if (!task) return res.status(404).json({ error: 'Tugas kurir tidak ditemukan.' });

    const penaltyShipping = fault_party === 'customer' ? task.rentals.delivery_fee : 0;

    // 1. Catat Berita Acara Penolakan di Lokasi
    await supabase.from('on_site_rejections').insert([{
      courier_task_id: taskId,
      rental_id: task.rental_id,
      rejection_category,
      fault_party,
      evidence_photo_url,
      courier_notes,
      return_shipping_fee_charged: penaltyShipping
    }]);

    // 2. Perbarui Status Tugas & Pesanan
    await supabase.from('courier_tasks').update({ status: 'rejected_on_site' }).eq('id', taskId);
    await supabase.from('rentals').update({ status: 'rejected_on_site' }).eq('id', task.rental_id);

    // 3. Berikan Strike / Penalti ke Pihak yang Bersalah
    if (fault_party === 'customer') {
      const { data: cust } = await supabase
        .from('users')
        .select('cod_unjustified_cancel_count, unpaid_cancellation_fee')
        .eq('id', task.rentals.customer_id)
        .single();

      const newCount = cust.cod_unjustified_cancel_count + 1;
      await supabase.from('users').update({
        cod_unjustified_cancel_count: newCount,
        is_cod_eligible: newCount < 2, // Otomatis blokir fitur COD jika 2x batal sepihak
        unpaid_cancellation_fee: Number(cust.unpaid_cancellation_fee) + Number(penaltyShipping)
      }).eq('id', task.rentals.customer_id);
    } else if (fault_party === 'vendor') {
      const { data: vendor } = await supabase
        .from('vendors')
        .select('item_defect_strike_count')
        .eq('id', task.rentals.vendor_id)
        .single();

      await supabase.from('vendors').update({
        item_defect_strike_count: vendor.item_defect_strike_count + 1
      }).eq('id', task.rentals.vendor_id);
    }

    res.json({ message: 'Penolakan di lokasi dicatat dan sanksi otomatis diterapkan.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Jalankan Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server RENTARA Backend berjalan di http://localhost:${PORT}`);
});