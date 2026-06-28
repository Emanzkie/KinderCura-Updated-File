const Appointment = require('../models/Appointment');
const Child = require('../models/Child');
const User = require('../models/User');
const { hasPermission } = require('../middleware/guardianAccess');
const paymentService = require('../services/paymentService');

function fullName(user) {
  if (!user) return null;
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || null;
}

async function canAccessAppointment(req, appointment) {
  if (!appointment) return false;
  if (req.user.role === 'admin') return true;
  if (String(appointment.parentId || '') === String(req.user.userId)) return true;
  if (String(appointment.pediatricianId || '') === String(req.user.userId)) return true;
  if (req.user.role === 'secretary' && req.user.linkedPediatricianId) {
    return String(appointment.pediatricianId || '') === String(req.user.linkedPediatricianId);
  }
  return hasPermission(req.user.userId, appointment.childId, 'manageAppointments');
}

async function resolveClinicPediatricianId(req) {
  if (req.user.role === 'admin') return null;
  if (req.user.role === 'pediatrician') return req.user.userId;
  if (req.user.role === 'secretary') {
    if (!req.user.linkedPediatricianId) {
      throw new Error('Assistant/Secretary account is not linked to a pediatrician yet.');
    }
    const secretary = await User.findById(req.user.userId).select('secretaryPermissions').lean();
    const perms = secretary?.secretaryPermissions || {};
    if (!perms.manageBookings && !perms.approveSchedules) {
      throw new Error('You do not have permission to manage payments.');
    }
    return req.user.linkedPediatricianId;
  }
  throw new Error('Clinic staff only.');
}

async function hydrateBalanceAppointment(appointment) {
  const [child, parent, pediatrician] = await Promise.all([
    Child.findById(appointment.childId).lean(),
    User.findById(appointment.parentId).lean(),
    appointment.pediatricianId ? User.findById(appointment.pediatricianId).lean() : null,
  ]);

  return {
    id: appointment.id,
    appointmentId: appointment.id,
    childId: child ? String(child._id) : null,
    parentId: parent ? String(parent._id) : null,
    pediatricianId: pediatrician ? String(pediatrician._id) : null,
    childName: child ? fullName(child) : 'Unknown Child',
    parentName: parent ? fullName(parent) : 'Unknown Parent',
    pediatricianName: pediatrician ? fullName(pediatrician) : null,
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    reason: appointment.reason,
    status: appointment.status,
    paymentStatus: appointment.paymentStatus,
    totalAmount: appointment.totalAmount || 0,
    amountPaid: appointment.amountPaid || 0,
    balanceDue: appointment.balanceDue || 0,
    nextInstallmentDate: appointment.nextInstallmentDate || null,
    requiredDownPayment: paymentService.calculateRequiredDownPayment(appointment.totalAmount || 0),
  };
}

async function quoteDownPayment(req, res) {
  try {
    const totalAmount = Number(req.query.totalAmount ?? req.body?.totalAmount ?? 0);
    if (!Number.isFinite(totalAmount) || totalAmount < 0) {
      return res.status(400).json({ error: 'Enter a valid total amount.' });
    }

    res.json({
      success: true,
      totalAmount: paymentService.roundCurrency(totalAmount),
      requiredDownPayment: paymentService.calculateRequiredDownPayment(totalAmount),
      downPaymentRate: paymentService.DOWN_PAYMENT_RATE,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getAppointmentPayments(req, res) {
  try {
    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) }).lean();
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });

    if (!await canAccessAppointment(req, appointment)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const payments = await paymentService.getPaymentsForAppointment(appointment._id);
    res.json({
      success: true,
      appointment: await hydrateBalanceAppointment(appointment),
      payments: payments.map(paymentService.serializePayment),
    });
  } catch (err) {
    console.error('getAppointmentPayments error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function getPendingBalances(req, res) {
  try {
    const pediatricianId = await resolveClinicPediatricianId(req);
    const appointments = await paymentService.getPendingBalanceAppointments({ pediatricianId });
    const balances = [];
    for (const appointment of appointments) {
      balances.push(await hydrateBalanceAppointment(appointment));
    }
    res.json({ success: true, balances });
  } catch (err) {
    const status = /permission|linked|staff/i.test(err.message) ? 403 : 500;
    console.error('getPendingBalances error:', err);
    res.status(status).json({ error: err.message });
  }
}

async function recordManualPayment(req, res) {
  try {
    await resolveClinicPediatricianId(req);

    const result = await paymentService.withPaymentTransaction(async (session) => {
      const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) }).session(session);
      if (!appointment) {
        const err = new Error('Appointment not found.');
        err.statusCode = 404;
        throw err;
      }

      if (!await canAccessAppointment(req, appointment)) {
        const err = new Error('Access denied.');
        err.statusCode = 403;
        throw err;
      }

      if (['cancelled', 'rejected'].includes(appointment.status)) {
        const err = new Error('Cannot record payment for a cancelled or rejected appointment.');
        err.statusCode = 400;
        throw err;
      }

      return paymentService.recordManualPayment({
        appointment,
        amountPaid: req.body.amountPaid,
        paymentMethod: req.body.paymentMethod || 'cash',
        paymentType: req.body.paymentType || 'balance_payment',
        nextInstallmentDate: req.body.nextInstallmentDate || null,
        notes: req.body.notes || null,
        actor: req.user,
        session,
      });
    });

    const updated = await Appointment.findOne({ id: Number(req.params.appointmentId) }).lean();

    res.json({
      success: true,
      payment: paymentService.serializePayment(result.payment),
      summary: await hydrateBalanceAppointment(updated),
    });
  } catch (err) {
    const status = err.statusCode || (/permission|linked|staff|access/i.test(err.message) ? 403 : 400);
    console.error('recordManualPayment error:', err);
    res.status(status).json({ error: err.message });
  }
}

module.exports = {
  getAppointmentPayments,
  getPendingBalances,
  quoteDownPayment,
  recordManualPayment,
};
